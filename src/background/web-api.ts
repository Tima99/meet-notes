import { fail, ok, type Result } from '../shared/messages';
import type { MeetingDetail, WebRequest } from '../shared/web-protocol';
import type { MeetingService } from './meeting-service';
import type { TranscriptService } from './transcript-service';

/**
 * Read-only API for the MeetNotes web panel. Only reachable through the bridge
 * content script, which Chrome injects solely on the configured panel origins;
 * the sender origin is checked again here.
 */
export function isAllowedWebOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  return origin !== undefined && allowed.includes(origin);
}

export class WebApi {
  constructor(
    private readonly meetings: MeetingService,
    private readonly transcripts: TranscriptService,
  ) {}

  async handle(request: WebRequest): Promise<Result<unknown>> {
    switch (request.type) {
      case 'list-meetings':
        return ok(await this.meetings.listRecent(1000));
      case 'get-meeting': {
        const meeting = await this.meetings.get(request.meetingId);
        if (!meeting) return fail('Meeting not found.');
        const detail: MeetingDetail = { meeting, segments: await this.transcripts.list(meeting.id) };
        return ok(detail);
      }
    }
  }
}
