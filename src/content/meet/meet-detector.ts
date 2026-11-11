import { createLogger, type Logger } from '../../shared/logger';
import type { MeetPageStatus } from '../../shared/types';
import { DEFAULT_MEET_UI_SELECTORS, type MeetUiSelectorConfig } from '../captions/selectors';

/** The code may follow a path prefix, e.g. /abc-defg-hij or /meet/abc-defg-hij. */
const MEET_CODE_PATTERN = /(?:^|\/)([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/i;

/** "https://meet.google.com/abc-defg-hij?authuser=0" → "abc-defg-hij". */
export function parseMeetCode(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'meet.google.com') return null;
    const match = MEET_CODE_PATTERN.exec(parsed.pathname);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** Meet titles look like "Meet - abc-defg-hij" or "Meet – Weekly sync". */
export function readMeetTitle(title: string, meetCode: string | null): string | null {
  const cleaned = title.replace(/^\s*(Google\s+)?Meet\s*[-–—:]\s*/i, '').trim();
  if (!cleaned || /^(google\s+)?meet$/i.test(cleaned) || cleaned.toLowerCase() === meetCode) return null;
  return cleaned;
}

export function detectInCall(doc: Document, selectors: MeetUiSelectorConfig = DEFAULT_MEET_UI_SELECTORS): boolean {
  for (const selector of selectors.leaveCallButton) {
    if (doc.querySelector(selector)) return true;
  }
  for (const icon of Array.from(doc.querySelectorAll(selectors.iconElements))) {
    if (icon.textContent?.trim() === selectors.leaveCallIconText) return true;
  }
  return false;
}

export function isElementVisible(element: Element): boolean {
  const candidate = element as Element & { checkVisibility?: () => boolean };
  if (typeof candidate.checkVisibility === 'function') {
    try {
      return candidate.checkVisibility();
    } catch {
      return true;
    }
  }
  return true;
}

export interface MeetDetectorDeps {
  readonly document: Document;
  readonly getUrl: () => string;
  readonly findCaptionRegion: (root: ParentNode) => Element | null;
  readonly uiSelectors?: MeetUiSelectorConfig;
  readonly pollIntervalMs?: number;
  readonly logger?: Logger;
}

export type MeetStatusListener = (status: MeetPageStatus, previous: MeetPageStatus) => void;

/**
 * Polls the page (1 s) for meeting code, in-call state and captions visibility.
 * Polling is deliberate: these signals are spread across Meet's whole DOM and a
 * subtree-wide observer for them would cost far more than a cheap periodic read.
 */
export class MeetDetector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: MeetPageStatus;
  private listener: MeetStatusListener | null = null;
  private readonly logger: Logger;

  constructor(private readonly deps: MeetDetectorDeps) {
    this.logger = deps.logger ?? createLogger('detector');
    this.current = this.read();
  }

  get status(): MeetPageStatus {
    return this.current;
  }

  start(listener: MeetStatusListener): void {
    this.listener = listener;
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), this.deps.pollIntervalMs ?? 1000);
    this.poll();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.listener = null;
  }

  /** Re-reads the page immediately and notifies on change. */
  poll(): MeetPageStatus {
    let next: MeetPageStatus;
    try {
      next = this.read();
    } catch (error) {
      this.logger.error('poll.failed', { error });
      return this.current;
    }
    const previous = this.current;
    if (!sameStatus(previous, next)) {
      this.current = next;
      this.logger.info('status.changed', { ...next });
      this.listener?.(next, previous);
    }
    return this.current;
  }

  private read(): MeetPageStatus {
    const { document: doc } = this.deps;
    const meetCode = parseMeetCode(this.deps.getUrl());
    const region = this.deps.findCaptionRegion(doc);
    return {
      meetCode,
      title: readMeetTitle(doc.title, meetCode),
      inCall: meetCode !== null && detectInCall(doc, this.deps.uiSelectors),
      // Hidden by MeetNotes (collapsed panel) still means captions are on.
      captionsVisible: region !== null && (region.closest('[data-meetnotes-hidden]') !== null || isElementVisible(region)),
    };
  }
}

function sameStatus(a: MeetPageStatus, b: MeetPageStatus): boolean {
  return a.meetCode === b.meetCode && a.title === b.title && a.inCall === b.inCall && a.captionsVisible === b.captionsVisible;
}
