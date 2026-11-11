import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { CaptureRegistry, type SessionStorageArea } from '../src/background/capture-registry';
import { CaptureService, type TabMessenger } from '../src/background/capture-service';
import { MeetingService } from '../src/background/meeting-service';
import { PanelHub } from '../src/background/panel-hub';
import { SettingsStore } from '../src/background/settings-store';
import { TranscriptService } from '../src/background/transcript-service';
import { openDatabase } from '../src/shared/db/idb';
import { IndexedDbMeetingRepository } from '../src/shared/db/meeting-repository';
import { DB_NAME } from '../src/shared/db/schema';
import { IndexedDbTranscriptRepository } from '../src/shared/db/transcript-repository';
import { ok, type ContentCommand } from '../src/shared/messages';
import type { TranscriptSegment } from '../src/shared/types';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

const seg = (
  id: string,
  sequence: number,
  text: string,
  { meetingId = 'm1', speaker = 'Alice', revision = 1, status = 'interim' as 'interim' | 'final' } = {},
): TranscriptSegment => ({
  id, meetingId, sequence, speaker, text, startedAt: 1000 + sequence, lastSpokenAt: 1000 + sequence,
  finalizedAt: status === 'final' ? 2000 : null, revision, status,
});

class MemoryArea implements SessionStorageArea {
  data: Record<string, unknown> = {};
  async get(key: string) { return { [key]: this.data[key] }; }
  async set(items: Record<string, unknown>) { Object.assign(this.data, items); }
}

function setup(factory = new IDBFactory()) {
  let db: Promise<IDBDatabase> | null = null;
  const database = () => (db ??= openDatabase({ factory }));
  const transcriptRepo = new IndexedDbTranscriptRepository(database);
  const meetingRepo = new IndexedDbMeetingRepository(database);
  const transcripts = new TranscriptService(transcriptRepo, () => 5000, silent);
  const meetings = new MeetingService(meetingRepo, transcripts, () => 5000, silent);
  const close = async () => (await database()).close();
  return { factory, transcripts, meetings, meetingRepo, transcriptRepo, close };
}

const startMeeting = (meetings: MeetingService, meetingId = 'm1', startedAt = 1000) =>
  meetings.start({ meetingId, meetCode: 'abc-defg-hij', title: 'Sync', startedAt });

describe('IndexedDB schema', () => {
  it('creates the meetings and transcripts stores with the required indexes', async () => {
    const db = await openDatabase({ factory: new IDBFactory() });
    expect([...db.objectStoreNames].sort()).toEqual(['meetings', 'transcripts']);
    const tx = db.transaction(['meetings', 'transcripts']);
    expect([...tx.objectStore('meetings').indexNames].sort()).toEqual(['startedAt', 'status']);
    expect([...tx.objectStore('transcripts').indexNames].sort()).toEqual(['meetingId', 'meetingId_sequence', 'timestamp']);
    expect(db.name).toBe(DB_NAME);
    db.close();
  });
});

describe('TranscriptService + repository', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(async () => {
    ctx = setup();
    await startMeeting(ctx.meetings);
  });

  it('saves segments and lists them in chronological (sequence) order', async () => {
    await ctx.transcripts.save([seg('c', 3, 'third'), seg('a', 1, 'first')]);
    await ctx.transcripts.save([seg('b', 2, 'second')]);
    expect((await ctx.transcripts.list('m1')).map((s) => s.text)).toEqual(['first', 'second', 'third']);
  });

  it('a newer revision replaces the stored one; a stale one is ignored', async () => {
    await ctx.transcripts.save([seg('a', 1, 'Hel', { revision: 1 })]);
    await ctx.transcripts.save([seg('a', 1, 'Hello world', { revision: 3, status: 'final' })]);
    const stale = await ctx.transcripts.save([seg('a', 1, 'Hello', { revision: 2 })]);
    expect(stale.written).toBe(0);
    expect(await ctx.transcripts.list('m1')).toEqual([expect.objectContaining({ text: 'Hello world', status: 'final', revision: 3 })]);
  });

  it('keeps the meeting summary (segment count, speakers) up to date', async () => {
    await ctx.transcripts.save([seg('a', 1, 'hi'), seg('b', 2, 'hey', { speaker: 'Bob' })]);
    await ctx.transcripts.save([seg('a', 1, 'hi there', { revision: 2 })]); // update, not a new segment
    await ctx.transcripts.save([seg('c', 3, 'yo', { speaker: 'Alice' })]);
    expect(await ctx.meetings.get('m1')).toMatchObject({ segmentCount: 3, speakers: ['Alice', 'Bob'] });
  });

  it('keeps meetings separate', async () => {
    await startMeeting(ctx.meetings, 'm2', 3000);
    await ctx.transcripts.save([seg('a', 1, 'one'), seg('x', 1, 'other', { meetingId: 'm2' })]);
    expect((await ctx.transcripts.list('m2')).map((s) => s.id)).toEqual(['x']);
  });

  it('data survives closing and reopening the database (extension restart)', async () => {
    await ctx.transcripts.save([seg('a', 1, 'persisted', { status: 'final' })]);
    await ctx.close();
    const reopened = setup(ctx.factory);
    expect((await reopened.transcripts.list('m1')).map((s) => s.text)).toEqual(['persisted']);
    expect(await reopened.meetings.get('m1')).toMatchObject({ status: 'active', title: 'Sync' });
  });

  it('handles a long meeting (5,000 segments) in order', async () => {
    const batch = Array.from({ length: 5000 }, (_, i) => seg(`s${i}`, i + 1, `line ${i + 1}`, { status: 'final' }));
    for (let i = 0; i < batch.length; i += 500) await ctx.transcripts.save(batch.slice(i, i + 500));
    const list = await ctx.transcripts.list('m1');
    expect(list).toHaveLength(5000);
    expect(list.at(-1)?.text).toBe('line 5000');
    expect(await ctx.meetings.get('m1')).toMatchObject({ segmentCount: 5000 });
  });
});

describe('MeetingService', () => {
  it('ending a meeting finalizes leftover interim segments; ending twice keeps the first end', async () => {
    const ctx = setup();
    await startMeeting(ctx.meetings);
    await ctx.transcripts.save([seg('a', 1, 'done', { status: 'final' }), seg('b', 2, 'cut off mid-sent')]);
    await ctx.meetings.end('m1', 'user-stopped', 9000);
    await ctx.meetings.end('m1', 'page-unloaded', 9999);
    expect(await ctx.meetings.get('m1')).toMatchObject({ status: 'ended', endedAt: 9000, endReason: 'user-stopped' });
    expect((await ctx.transcripts.list('m1')).map((s) => [s.text, s.status])).toEqual([
      ['done', 'final'],
      ['cut off mid-sent', 'final'], // kept, not lost
    ]);
  });

  it('recovers meetings left active by a crash, but not ones still capturing', async () => {
    const ctx = setup();
    await startMeeting(ctx.meetings, 'crashed', 1000);
    await startMeeting(ctx.meetings, 'live', 2000);
    await ctx.transcripts.save([seg('a', 1, 'interim words', { meetingId: 'crashed' })]);
    const recovered = await ctx.meetings.recoverInterrupted(new Set(['live']));
    expect(recovered).toBe(1);
    expect(await ctx.meetings.get('crashed')).toMatchObject({ status: 'ended', endReason: 'interrupted' });
    expect(await ctx.meetings.get('live')).toMatchObject({ status: 'active' });
    expect((await ctx.transcripts.list('crashed'))[0]?.status).toBe('final');
  });

  it('lists meetings newest first', async () => {
    const ctx = setup();
    await startMeeting(ctx.meetings, 'old', 1000);
    await startMeeting(ctx.meetings, 'new', 3000);
    await startMeeting(ctx.meetings, 'mid', 2000);
    expect((await ctx.meetings.listRecent()).map((m) => m.id)).toEqual(['new', 'mid', 'old']);
  });
});

describe('CaptureService end-to-end with IndexedDB', () => {
  function service() {
    const ctx = setup();
    const page = { meetCode: 'abc-defg-hij', title: 'Sync', inCall: true, captionsVisible: true };
    let capture: { meetingId: string; startedAt: number } | null = null;
    const sent: ContentCommand[] = [];
    const tabs: TabMessenger = {
      async send(_tabId, command) {
        sent.push(command);
        if (command.type === 'content/start-capture') capture = { meetingId: command.meetingId, startedAt: command.startedAt };
        if (command.type === 'content/stop-capture') capture = null;
        return ok({ page, capture });
      },
    };
    const registry = new CaptureRegistry(new MemoryArea(), silent);
    const svc = new CaptureService(registry, ctx.transcripts, ctx.meetings, new PanelHub(silent), new SettingsStore(new MemoryArea()), tabs, () => 1000, silent);
    return { ...ctx, svc, registry, sent };
  }

  it('creates the meeting before capture starts, saves segments, and closes it on stop', async () => {
    const { svc, meetings, sent } = service();
    const { state } = await svc.start(7);
    const meetingId = state.capture?.meetingId;
    if (!meetingId) throw new Error('not capturing');
    expect(sent.some((c) => c.type === 'content/start-capture')).toBe(true);
    expect(await meetings.get(meetingId)).toMatchObject({ status: 'active', meetCode: 'abc-defg-hij' });

    await svc.handleContentEvent(7, { type: 'content/segments', segments: [seg('a', 1, 'Hello', { meetingId, status: 'final' })] });
    const snapshot = await svc.stop(7);
    expect(snapshot.segments.map((s) => s.text)).toEqual(['Hello']); // read back from IndexedDB
    expect(await meetings.get(meetingId)).toMatchObject({ status: 'ended', endReason: 'user-stopped', segmentCount: 1 });
  });

  it('discards the meeting row if the Meet tab refuses to start', async () => {
    const ctx = setup();
    const tabs: TabMessenger = { send: async () => ({ ok: false, error: 'not a meeting' }) };
    const svc = new CaptureService(new CaptureRegistry(new MemoryArea(), silent), ctx.transcripts, ctx.meetings, new PanelHub(silent), new SettingsStore(new MemoryArea()), tabs, () => 1000, silent);
    await expect(svc.start(1)).rejects.toThrow('not a meeting');
    expect(await ctx.meetings.listRecent()).toEqual([]);
  });

  it('on startup, recovers interrupted meetings but keeps the ones the registry still knows', async () => {
    const { svc, meetings, registry } = service();
    const { state } = await svc.start(7);
    await startMeeting(meetings, 'orphan', 500);
    await svc.recover();
    expect(await meetings.get('orphan')).toMatchObject({ status: 'ended', endReason: 'interrupted' });
    expect(registry.activeMeetingIds().has(state.capture?.meetingId ?? '')).toBe(true);
    expect(await meetings.get(state.capture?.meetingId ?? '')).toMatchObject({ status: 'active' });
  });
});
