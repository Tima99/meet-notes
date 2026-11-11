/**
 * MeetNotes IndexedDB schema. Lives in the extension's own origin, so the
 * service worker (writer) and the side panel (reader) share it. Nothing ever
 * leaves the browser.
 *
 *   meetings     keyPath id         indexes: startedAt, status
 *   transcripts  keyPath id         indexes: meetingId, timestamp, meetingId_sequence
 */
import type { CaptureEndReason, TranscriptSegment } from '../types';

export const DB_NAME = 'meetnotes';
export const DB_VERSION = 1;

export const STORES = {
  meetings: 'meetings',
  transcripts: 'transcripts',
} as const;

export const MEETING_INDEXES = {
  startedAt: 'startedAt',
  status: 'status',
} as const;

export const TRANSCRIPT_INDEXES = {
  meetingId: 'meetingId',
  /** Segment start time (`startedAt`). */
  timestamp: 'timestamp',
  /** [meetingId, sequence] — one meeting's segments in chronological order. */
  meetingSequence: 'meetingId_sequence',
} as const;

export type MeetingStatus = 'active' | 'ended';

/** `interrupted` = the browser/extension stopped without a clean end (recovered on next start). */
export type MeetingEndReason = CaptureEndReason | 'interrupted';

export interface MeetingRecord {
  readonly id: string;
  readonly meetCode: string | null;
  readonly title: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly endReason: MeetingEndReason | null;
  readonly status: MeetingStatus;
  /** Number of distinct segments saved. */
  readonly segmentCount: number;
  /** Distinct speaker names, in order of first appearance. */
  readonly speakers: readonly string[];
  readonly updatedAt: number;
}

/** A saved segment: exactly what the tracker produced, plus when it was written. */
export interface TranscriptRecord extends TranscriptSegment {
  readonly savedAt: number;
}

/** Creates/migrates stores. Each `oldVersion` step must stay forever (users upgrade from any version). */
export function upgradeSchema(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    const meetings = db.createObjectStore(STORES.meetings, { keyPath: 'id' });
    meetings.createIndex(MEETING_INDEXES.startedAt, 'startedAt');
    meetings.createIndex(MEETING_INDEXES.status, 'status');

    const transcripts = db.createObjectStore(STORES.transcripts, { keyPath: 'id' });
    transcripts.createIndex(TRANSCRIPT_INDEXES.meetingId, 'meetingId');
    transcripts.createIndex(TRANSCRIPT_INDEXES.timestamp, 'startedAt');
    transcripts.createIndex(TRANSCRIPT_INDEXES.meetingSequence, ['meetingId', 'sequence']);
  }
}
