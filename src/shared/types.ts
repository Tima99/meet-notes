/**
 * Domain model shared by every MeetNotes context (content script, service worker, side panel).
 * Keep this file free of runtime dependencies so it can be imported anywhere.
 */

/**
 * `interim` = Meet is still writing this caption.
 * `final`   = stable and saved. If Meet later corrects the same caption block, the
 *             segment is amended in place (same id, higher revision) — never duplicated.
 */
export type SegmentStatus = 'interim' | 'final';

export interface TranscriptSegment {
  /** Unique, stable ID. Updates to the same utterance reuse it (upsert semantics). */
  readonly id: string;
  readonly meetingId: string;
  /** Monotonic per meeting; the canonical chronological order. */
  readonly sequence: number;
  readonly speaker: string;
  /** Caption text exactly as Meet rendered it (whitespace collapsed only). */
  readonly text: string;
  /** Epoch ms when the utterance first appeared. */
  readonly startedAt: number;
  /** Epoch ms of the last text change. */
  readonly lastSpokenAt: number;
  /**
   * Increases on every change to this segment. A newer revision always wins, so
   * out-of-order delivery can never roll a segment back.
   */
  readonly revision: number;
  /** Epoch ms when the segment was finalized, null while interim. */
  readonly finalizedAt: number | null;
  readonly status: SegmentStatus;
}

/** What the Meet tab currently looks like. */
export interface MeetPageStatus {
  /** e.g. "abc-defg-hij"; null when the URL is not a meeting URL (landing page, etc). */
  readonly meetCode: string | null;
  readonly title: string | null;
  /** True when the in-call controls (leave-call button) are present. */
  readonly inCall: boolean;
  /** True when the captions region is present and visible. */
  readonly captionsVisible: boolean;
}

export type CaptureEndReason =
  | 'user-stopped'
  | 'meeting-ended'
  | 'page-unloaded'
  | 'extension-invalidated'
  | 'error';

/** A capture session as known by the content script. */
export interface ContentCaptureState {
  readonly meetingId: string;
  readonly startedAt: number;
}

/** A capture session as tracked by the service worker. */
export interface CaptureSession {
  readonly meetingId: string;
  readonly tabId: number;
  readonly meetCode: string | null;
  readonly title: string | null;
  readonly startedAt: number;
}

/** Meet's caption (speech recognition) language, as offered by Meet. */
export interface CaptionLanguageInfo {
  readonly current: string | null;
  readonly options: readonly string[];
}

/** Aggregated view of one browser tab, as shown in the side panel. */
export interface TabState {
  readonly tabId: number;
  /** False when no MeetNotes content script answers in this tab. */
  readonly contentReady: boolean;
  readonly page: MeetPageStatus | null;
  readonly capture: CaptureSession | null;
}
