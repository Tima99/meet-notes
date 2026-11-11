import type { TranscriptSegment } from '../types';
import { promisifyRequest, withTransaction } from './idb';
import { STORES, TRANSCRIPT_INDEXES, type MeetingRecord, type TranscriptRecord } from './schema';

export interface UpsertResult {
  /** Segments actually written (newer revision than what was stored). */
  readonly written: number;
  /** Segments that did not exist before. */
  readonly inserted: number;
}

export interface TranscriptRepository {
  /** Writes segments whose revision is newer than the stored one; updates the meeting's counters. */
  upsert(segments: readonly TranscriptSegment[], savedAt: number): Promise<UpsertResult>;
  listByMeeting(meetingId: string): Promise<TranscriptRecord[]>;
  /** Marks every still-interim segment of a meeting as final. Returns how many changed. */
  finalizeMeeting(meetingId: string, finalizedAt: number): Promise<number>;
  deleteByMeeting(meetingId: string): Promise<void>;
}

export class IndexedDbTranscriptRepository implements TranscriptRepository {
  constructor(private readonly db: () => Promise<IDBDatabase>) {}

  async upsert(segments: readonly TranscriptSegment[], savedAt: number): Promise<UpsertResult> {
    if (segments.length === 0) return { written: 0, inserted: 0 };
    const db = await this.db();
    return withTransaction(db, [STORES.transcripts, STORES.meetings], 'readwrite', async (tx) => {
      const transcripts = tx.objectStore(STORES.transcripts);
      const meetings = tx.objectStore(STORES.meetings);
      let written = 0;
      let inserted = 0;
      const newByMeeting = new Map<string, TranscriptSegment[]>();

      for (const segment of segments) {
        const existing = (await promisifyRequest(transcripts.get(segment.id))) as TranscriptRecord | undefined;
        // A newer revision always wins; stale/out-of-order deliveries are ignored.
        if (existing && existing.revision >= segment.revision) continue;
        const record: TranscriptRecord = { ...segment, savedAt };
        await promisifyRequest(transcripts.put(record));
        written++;
        if (!existing) {
          inserted++;
          const list = newByMeeting.get(segment.meetingId) ?? [];
          list.push(segment);
          newByMeeting.set(segment.meetingId, list);
        }
      }

      // Keep the meeting summary (segment count, speakers) in the same transaction.
      for (const [meetingId, added] of newByMeeting) {
        const meeting = (await promisifyRequest(meetings.get(meetingId))) as MeetingRecord | undefined;
        if (!meeting) continue;
        const speakers = [...meeting.speakers];
        // In order of first appearance in the conversation, whatever order the batch had.
        for (const s of [...added].sort((x, y) => x.sequence - y.sequence)) {
          if (!speakers.includes(s.speaker)) speakers.push(s.speaker);
        }
        const updated: MeetingRecord = {
          ...meeting,
          segmentCount: meeting.segmentCount + added.length,
          speakers,
          updatedAt: savedAt,
        };
        await promisifyRequest(meetings.put(updated));
      }
      return { written, inserted };
    });
  }

  async listByMeeting(meetingId: string): Promise<TranscriptRecord[]> {
    const db = await this.db();
    return withTransaction(db, STORES.transcripts, 'readonly', async (tx) => {
      const index = tx.objectStore(STORES.transcripts).index(TRANSCRIPT_INDEXES.meetingSequence);
      const range = IDBKeyRange.bound([meetingId, -Infinity], [meetingId, Infinity]);
      return (await promisifyRequest(index.getAll(range))) as TranscriptRecord[];
    });
  }

  async finalizeMeeting(meetingId: string, finalizedAt: number): Promise<number> {
    const db = await this.db();
    return withTransaction(db, STORES.transcripts, 'readwrite', async (tx) => {
      const store = tx.objectStore(STORES.transcripts);
      const all = (await promisifyRequest(store.index(TRANSCRIPT_INDEXES.meetingId).getAll(meetingId))) as TranscriptRecord[];
      let changed = 0;
      for (const record of all) {
        if (record.status === 'final') continue;
        await promisifyRequest(
          store.put({ ...record, status: 'final', finalizedAt, revision: record.revision + 1, savedAt: finalizedAt }),
        );
        changed++;
      }
      return changed;
    });
  }

  async deleteByMeeting(meetingId: string): Promise<void> {
    const db = await this.db();
    await withTransaction(db, STORES.transcripts, 'readwrite', async (tx) => {
      const store = tx.objectStore(STORES.transcripts);
      const keys = await promisifyRequest(store.index(TRANSCRIPT_INDEXES.meetingId).getAllKeys(meetingId));
      for (const key of keys) await promisifyRequest(store.delete(key));
    });
  }
}
