import type { TranscriptSegment } from '../shared/types';

/**
 * Where segments go once they reach the service worker.
 * Phase 1: in memory (lost when the SW is suspended).
 * Phase 2: replaced by an IndexedDB-backed TranscriptService with the same contract.
 */
export interface SegmentStore {
  upsert(segments: readonly TranscriptSegment[]): Promise<void>;
  listByMeeting(meetingId: string): Promise<TranscriptSegment[]>;
}

export class InMemorySegmentStore implements SegmentStore {
  private readonly byMeeting = new Map<string, Map<string, TranscriptSegment>>();

  async upsert(segments: readonly TranscriptSegment[]): Promise<void> {
    for (const segment of segments) {
      let meeting = this.byMeeting.get(segment.meetingId);
      if (!meeting) {
        meeting = new Map();
        this.byMeeting.set(segment.meetingId, meeting);
      }
      const existing = meeting.get(segment.id);
      // Out-of-order delivery must never roll a segment back.
      if (existing && existing.revision >= segment.revision) continue;
      meeting.set(segment.id, segment);
    }
  }

  async listByMeeting(meetingId: string): Promise<TranscriptSegment[]> {
    const meeting = this.byMeeting.get(meetingId);
    if (!meeting) return [];
    return [...meeting.values()].sort((a, b) => a.sequence - b.sequence);
  }
}
