// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { MeetNotesClient } from '../web/src/extension-client';
import { buildManifest, resolveWebOrigins } from '../build/web-origins';
import { MeetingService } from '../src/background/meeting-service';
import { TranscriptService } from '../src/background/transcript-service';
import { isAllowedWebOrigin, WebApi } from '../src/background/web-api';
import { openDatabase } from '../src/shared/db/idb';
import { IndexedDbMeetingRepository } from '../src/shared/db/meeting-repository';
import type { MeetingRecord } from '../src/shared/db/schema';
import { IndexedDbTranscriptRepository } from '../src/shared/db/transcript-repository';
import { exportFileName, toArchiveJson, toJsonExport, toTxt } from '../src/shared/export/transcript-export';
import type { BackgroundWebRequest } from '../src/shared/web-protocol';
import { startBridge } from '../src/web-bridge/index';
import type { TranscriptSegment } from '../src/shared/types';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

const meeting: MeetingRecord = {
  id: 'm1', meetCode: 'zny-tpve-aja', title: 'Weekly sync', startedAt: Date.UTC(2026, 10, 11, 14, 0, 0),
  endedAt: Date.UTC(2026, 10, 11, 14, 42, 10), endReason: 'user-stopped', status: 'ended',
  segmentCount: 2, speakers: ['Amit Kumar', 'You'], updatedAt: 0,
};
const seg = (id: string, sequence: number, speaker: string, text: string, offsetS: number): TranscriptSegment => ({
  id, meetingId: 'm1', sequence, speaker, text, startedAt: meeting.startedAt + offsetS * 1000,
  lastSpokenAt: meeting.startedAt + offsetS * 1000, finalizedAt: 1, revision: 2, status: 'final',
});
const segments = [seg('b', 2, 'You', 'हेलो, all good?', 65), seg('a', 1, 'Amit Kumar', 'Hello, everyone.', 3)];

describe('MEETNOTES_WEB_ORIGINS', () => {
  it('defaults to the local dev panel and normalises origins', () => {
    expect(resolveWebOrigins(undefined)).toEqual(['http://localhost:5174']);
    expect(resolveWebOrigins(' https://my-notes.vercel.app/ , http://localhost:5174')).toEqual([
      'https://my-notes.vercel.app',
      'http://localhost:5174',
    ]);
  });
  it.each([
    ['https://*.vercel.app', /wildcards/],
    ['http://my-notes.vercel.app', /https/],
    ['https://my-notes.vercel.app/admin', /without a path/],
    ['not a url', /valid URL/],
  ])('rejects %s', (input, message) => {
    expect(() => resolveWebOrigins(input)).toThrow(message);
  });
  it('adds the bridge content script only for the configured origins', () => {
    const manifest = buildManifest({ content_scripts: [{ matches: ['https://meet.google.com/*'], js: ['content.js'] }] }, [
      'https://my-notes.vercel.app',
      'http://localhost:5174',
    ]);
    expect(manifest.content_scripts?.[1]).toEqual({
      matches: ['https://my-notes.vercel.app/*', 'http://localhost/*'],
      js: ['web-bridge.js'],
      run_at: 'document_start',
    });
  });
});

describe('export service', () => {
  it('TXT: header + chronological lines with offsets, wording untouched', () => {
    expect(toTxt(meeting, segments, { timeZone: 'UTC' })).toBe(
      [
        'Weekly sync',
        'Meeting code: zny-tpve-aja',
        `Date: ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(meeting.startedAt)}`,
        'Duration: 42:10',
        'Participants: Amit Kumar, You',
        '',
        '[00:00:03] Amit Kumar: Hello, everyone.',
        '[00:01:05] You: हेलो, all good?',
        '',
      ].join('\n'),
    );
  });
  it('JSON: versioned, ISO dates, ordered segments with offsets', () => {
    const json = toJsonExport(meeting, segments, Date.UTC(2026, 10, 12));
    expect(json).toMatchObject({
      format: 'meetnotes.transcript',
      version: 1,
      exportedAt: '2026-11-12T00:00:00.000Z',
      meeting: { id: 'm1', startedAt: '2026-11-11T14:00:00.000Z', durationMs: 2_530_000, speakers: ['Amit Kumar', 'You'] },
    });
    expect(json.segments.map((s) => [s.sequence, s.offsetMs, s.text])).toEqual([
      [1, 3000, 'Hello, everyone.'],
      [2, 65000, 'हेलो, all good?'],
    ]);
    expect(JSON.parse(toArchiveJson([{ meeting, segments }], 0))).toMatchObject({ format: 'meetnotes.archive', meetings: [{ meeting: { id: 'm1' } }] });
  });
  it('file names are safe and dated', () => {
    expect(exportFileName(meeting, 'txt')).toBe('meetnotes-2026-11-11-weekly-sync.txt');
    expect(exportFileName({ ...meeting, title: null }, 'json')).toBe('meetnotes-2026-11-11-zny-tpve-aja.json');
  });
});

describe('web API (read-only, origin-checked)', () => {
  it('only accepts the configured origins', () => {
    expect(isAllowedWebOrigin('https://panel.example.com', ['https://panel.example.com'])).toBe(true);
    expect(isAllowedWebOrigin('https://evil.example.com', ['https://panel.example.com'])).toBe(false);
    expect(isAllowedWebOrigin(undefined, ['https://panel.example.com'])).toBe(false);
  });
});

describe('page ↔ bridge ↔ background round trip', () => {
  // jsdom's postMessage leaves event.origin empty and event.source null; Chrome
  // fills both (and our code rightly rejects messages without them). Emulate Chrome.
  const realPostMessage = window.postMessage.bind(window);
  window.postMessage = ((data: unknown) => {
    setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: structuredClone(data), origin: location.origin, source: window })), 0);
  }) as typeof window.postMessage;
  afterAll(() => {
    window.postMessage = realPostMessage;
  });

  let dispose: (() => void)[] = [];
  afterEach(() => {
    for (const d of dispose) d();
    dispose = [];
  });

  async function backgroundWithData() {
    const factory = new IDBFactory();
    let db: Promise<IDBDatabase> | null = null;
    const database = () => (db ??= openDatabase({ factory }));
    const transcripts = new TranscriptService(new IndexedDbTranscriptRepository(database), () => 1, silent);
    const meetings = new MeetingService(new IndexedDbMeetingRepository(database), transcripts, () => 1, silent);
    await meetings.start({ meetingId: 'm1', meetCode: 'zny-tpve-aja', title: 'Weekly sync', startedAt: meeting.startedAt });
    await transcripts.save(segments);
    return new WebApi(meetings, transcripts);
  }

  it('detects the extension, lists meetings and loads a transcript from IndexedDB', async () => {
    const api = await backgroundWithData();
    const seen: BackgroundWebRequest[] = [];
    dispose.push(
      startBridge({
        window,
        extensionVersion: '0.1.0',
        sendToBackground: async (message) => {
          seen.push(message);
          return api.handle(message.request);
        },
      }),
    );
    const client = new MeetNotesClient(window);
    dispose.push(() => client.dispose());

    expect(await client.connect(1000)).toEqual({ extensionVersion: '0.1.0' });
    const list = await client.request({ type: 'list-meetings' });
    expect(list.map((m) => [m.id, m.segmentCount, m.speakers])).toEqual([['m1', 2, ['Amit Kumar', 'You']]]);
    const detail = await client.request({ type: 'get-meeting', meetingId: 'm1' });
    expect(detail.segments.map((s) => s.text)).toEqual(['Hello, everyone.', 'हेलो, all good?']);
    expect(seen.every((m) => m.type === 'web/request')).toBe(true);
  });

  it('reports "not detected" when no bridge is installed', async () => {
    const client = new MeetNotesClient(window);
    dispose.push(() => client.dispose());
    expect(await client.connect(400)).toBeNull();
  });

  it('surfaces background errors to the page', async () => {
    const api = await backgroundWithData();
    dispose.push(startBridge({ window, extensionVersion: '0.1.0', sendToBackground: async (m) => api.handle(m.request) }));
    const client = new MeetNotesClient(window);
    dispose.push(() => client.dispose());
    await client.connect(1000);
    await expect(client.request({ type: 'get-meeting', meetingId: 'nope' })).rejects.toThrow('Meeting not found.');
  });

  it('ignores messages that are not from this page', async () => {
    let calls = 0;
    dispose.push(startBridge({ window, extensionVersion: '0.1.0', sendToBackground: async () => (calls++, { ok: true, data: [] }) }));
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'meetnotes-web', kind: 'request', id: 'x', request: { type: 'list-meetings' } },
        origin: 'https://evil.example.com',
        source: window,
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(0);
  });
});
