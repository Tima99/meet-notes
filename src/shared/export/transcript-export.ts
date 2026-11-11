/**
 * Export service: turns a saved meeting into TXT or JSON. Pure functions — the
 * caption wording is copied verbatim, never edited.
 */
import type { MeetingRecord } from '../db/schema';
import { formatDateTime, formatDuration, formatOffset } from '../format';
import type { TranscriptSegment } from '../types';

export const JSON_EXPORT_FORMAT = 'meetnotes.transcript';
export const JSON_EXPORT_VERSION = 1;

export interface ExportOptions {
  /** IANA zone for human-readable dates (defaults to the viewer's zone). */
  readonly timeZone?: string;
}

export function meetingTitle(meeting: MeetingRecord): string {
  return meeting.title ?? meeting.meetCode ?? 'Untitled meeting';
}

/** Duration of a meeting; for one still running, up to its last activity. */
export function meetingDuration(meeting: MeetingRecord, segments: readonly TranscriptSegment[] = []): number {
  const lastSpoken = Math.max(meeting.startedAt, ...segments.map((s) => s.lastSpokenAt));
  return (meeting.endedAt ?? Math.max(lastSpoken, meeting.updatedAt)) - meeting.startedAt;
}

function ordered(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  return [...segments].sort((a, b) => a.sequence - b.sequence);
}

function speakersOf(meeting: MeetingRecord, segments: readonly TranscriptSegment[]): string[] {
  const seen = [...meeting.speakers];
  for (const s of segments) if (!seen.includes(s.speaker)) seen.push(s.speaker);
  return seen;
}

/**
 * Human-readable transcript:
 *
 *   Weekly sync
 *   Meeting code: abc-defg-hij
 *   Date: Nov 11, 2026, 7:52 PM
 *   Duration: 42:10
 *   Participants: Alice, Bob
 *
 *   [00:00:03] Alice: Hello everyone.
 */
export function toTxt(meeting: MeetingRecord, segments: readonly TranscriptSegment[], options: ExportOptions = {}): string {
  const lines = [
    meetingTitle(meeting),
    ...(meeting.meetCode ? [`Meeting code: ${meeting.meetCode}`] : []),
    `Date: ${formatDateTime(meeting.startedAt, options.timeZone)}`,
    `Duration: ${formatDuration(meetingDuration(meeting, segments))}`,
    `Participants: ${speakersOf(meeting, segments).join(', ') || '—'}`,
    '',
    ...ordered(segments).map((s) => `[${formatOffset(s.startedAt - meeting.startedAt)}] ${s.speaker}: ${s.text}`),
  ];
  return `${lines.join('\n')}\n`;
}

export interface JsonExport {
  readonly format: typeof JSON_EXPORT_FORMAT;
  readonly version: typeof JSON_EXPORT_VERSION;
  readonly exportedAt: string;
  readonly meeting: {
    readonly id: string;
    readonly title: string | null;
    readonly meetCode: string | null;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly durationMs: number;
    readonly status: MeetingRecord['status'];
    readonly endReason: MeetingRecord['endReason'];
    readonly speakers: readonly string[];
  };
  readonly segments: readonly {
    readonly id: string;
    readonly sequence: number;
    readonly speaker: string;
    readonly text: string;
    readonly startedAt: string;
    readonly offsetMs: number;
    readonly status: TranscriptSegment['status'];
  }[];
}

export function toJsonExport(meeting: MeetingRecord, segments: readonly TranscriptSegment[], exportedAt: number): JsonExport {
  return {
    format: JSON_EXPORT_FORMAT,
    version: JSON_EXPORT_VERSION,
    exportedAt: new Date(exportedAt).toISOString(),
    meeting: {
      id: meeting.id,
      title: meeting.title,
      meetCode: meeting.meetCode,
      startedAt: new Date(meeting.startedAt).toISOString(),
      endedAt: meeting.endedAt === null ? null : new Date(meeting.endedAt).toISOString(),
      durationMs: meetingDuration(meeting, segments),
      status: meeting.status,
      endReason: meeting.endReason,
      speakers: speakersOf(meeting, segments),
    },
    segments: ordered(segments).map((s) => ({
      id: s.id,
      sequence: s.sequence,
      speaker: s.speaker,
      text: s.text,
      startedAt: new Date(s.startedAt).toISOString(),
      offsetMs: Math.max(0, s.startedAt - meeting.startedAt),
      status: s.status,
    })),
  };
}

export function toJson(meeting: MeetingRecord, segments: readonly TranscriptSegment[], exportedAt: number): string {
  return `${JSON.stringify(toJsonExport(meeting, segments, exportedAt), null, 2)}\n`;
}

/** "meetnotes-2026-11-11-weekly-sync.txt" (date in UTC so names are stable). */
export function exportFileName(meeting: MeetingRecord, extension: 'txt' | 'json'): string {
  const date = new Date(meeting.startedAt).toISOString().slice(0, 10);
  const slug = meetingTitle(meeting)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `meetnotes-${date}${slug ? `-${slug}` : ''}.${extension}`;
}

export const ARCHIVE_EXPORT_FORMAT = 'meetnotes.archive';

/** Every meeting in one JSON file ("Export all"). */
export function toArchiveJson(
  meetings: readonly { readonly meeting: MeetingRecord; readonly segments: readonly TranscriptSegment[] }[],
  exportedAt: number,
): string {
  const archive = {
    format: ARCHIVE_EXPORT_FORMAT,
    version: JSON_EXPORT_VERSION,
    exportedAt: new Date(exportedAt).toISOString(),
    meetings: meetings.map(({ meeting, segments }) => toJsonExport(meeting, segments, exportedAt)),
  };
  return `${JSON.stringify(archive, null, 2)}\n`;
}
