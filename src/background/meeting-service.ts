import { createLogger, type Logger } from '../shared/logger';
import type { MeetingRepository } from '../shared/db/meeting-repository';
import type { MeetingEndReason, MeetingRecord } from '../shared/db/schema';
import type { CaptureSession } from '../shared/types';
import type { TranscriptService } from './transcript-service';

/** Meeting lifecycle in the database: start, end, and crash recovery. */
export class MeetingService {
  constructor(
    private readonly repository: MeetingRepository,
    private readonly transcripts: TranscriptService,
    private readonly now: () => number = Date.now,
    private readonly logger: Logger = createLogger('meetings'),
  ) {}

  /** Idempotent: re-starting an existing meeting returns the stored record. */
  async start(session: Omit<CaptureSession, 'tabId'>): Promise<MeetingRecord> {
    const record = await this.repository.create({
      id: session.meetingId,
      meetCode: session.meetCode,
      title: session.title,
      startedAt: session.startedAt,
      endedAt: null,
      endReason: null,
      status: 'active',
      segmentCount: 0,
      speakers: [],
      updatedAt: this.now(),
    });
    this.logger.info('started', { meetingId: record.id });
    return record;
  }

  /** Idempotent: an already-ended meeting keeps its original end time and reason. */
  async end(meetingId: string, reason: MeetingEndReason, endedAt: number): Promise<MeetingRecord | null> {
    await this.transcripts.finalizeMeeting(meetingId, endedAt);
    const record = await this.repository.update(meetingId, (m) =>
      m.status === 'ended' ? m : { ...m, status: 'ended', endedAt, endReason: reason, updatedAt: this.now() },
    );
    if (record) this.logger.info('ended', { meetingId, reason });
    return record;
  }

  /** Fill in / refresh the meeting's code and title as the Meet tab reports them. */
  async describe(meetingId: string, meetCode: string | null, title: string | null): Promise<void> {
    await this.repository.update(meetingId, (m) =>
      (meetCode === null || m.meetCode === meetCode) && (title === null || m.title === title)
        ? m
        : { ...m, meetCode: meetCode ?? m.meetCode, title: title ?? m.title, updatedAt: this.now() },
    );
  }

  /** Remove a meeting that never really started (e.g. the Meet tab refused the start). */
  async discard(meetingId: string): Promise<void> {
    await this.repository.delete(meetingId);
  }

  get(meetingId: string): Promise<MeetingRecord | null> {
    return this.repository.get(meetingId);
  }

  listRecent(limit = 50): Promise<MeetingRecord[]> {
    return this.repository.listRecent(limit);
  }

  /**
   * After a browser restart or crash, meetings can be left "active" with nobody
   * capturing them. Close those as `interrupted` (ended at their last activity)
   * and finalize their interim segments. Meetings in `stillCapturing` are kept.
   */
  async recoverInterrupted(stillCapturing: ReadonlySet<string>): Promise<number> {
    let recovered = 0;
    for (const meeting of await this.repository.listActive()) {
      if (stillCapturing.has(meeting.id)) continue;
      await this.end(meeting.id, 'interrupted', meeting.updatedAt);
      recovered++;
    }
    if (recovered > 0) this.logger.warn('recovered-interrupted', { meetings: recovered });
    return recovered;
  }
}
