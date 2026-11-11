import { createLogger, type Logger } from '../shared/logger';
import type { TranscriptRepository, UpsertResult } from '../shared/db/transcript-repository';
import type { TranscriptSegment } from '../shared/types';

/**
 * Persists transcript segments as they arrive.
 *  - final segments: saved immediately (the content script sends them at once);
 *  - interim segments: saved too, as checkpoints, so a crash mid-sentence keeps
 *    what was captured so far. A newer revision always replaces an older one.
 * Resolves only after the write has committed — the content script keeps a
 * segment queued until then.
 */
export class TranscriptService {
  constructor(
    private readonly repository: TranscriptRepository,
    private readonly now: () => number = Date.now,
    private readonly logger: Logger = createLogger('transcripts'),
  ) {}

  async save(segments: readonly TranscriptSegment[]): Promise<UpsertResult> {
    const result = await this.repository.upsert(segments, this.now());
    if (result.inserted > 0) this.logger.debug('saved', { ...result });
    return result;
  }

  async list(meetingId: string): Promise<TranscriptSegment[]> {
    const records = await this.repository.listByMeeting(meetingId);
    return records.map(({ savedAt: _savedAt, ...segment }) => segment);
  }

  /** Closes whatever is still interim (meeting ended or was interrupted). */
  async finalizeMeeting(meetingId: string, at: number): Promise<number> {
    const changed = await this.repository.finalizeMeeting(meetingId, at);
    if (changed > 0) this.logger.info('interim-finalized', { meetingId, segments: changed });
    return changed;
  }
}
