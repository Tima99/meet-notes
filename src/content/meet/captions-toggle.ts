import { createLogger, type Logger } from '../../shared/logger';
import { isRendered } from '../captions/dom-utils';
import { DEFAULT_CAPTION_SELECTORS, DEFAULT_MEET_UI_SELECTORS, type MeetUiSelectorConfig } from '../captions/selectors';

/** Anything inside the captions UI is never the toolbar CC button. */
const CAPTIONS_UI = [...DEFAULT_CAPTION_SELECTORS.panel, ...DEFAULT_CAPTION_SELECTORS.region].join(', ');
const isInCaptionsUi = (el: Element): boolean => el.closest(CAPTIONS_UI) !== null;

export type EnsureCaptionsResult = 'already-on' | 'turned-on' | 'no-button' | 'timed-out';

export interface CaptionsToggle {
  /** Turns Meet's captions on if they are off. */
  ensureOn(): Promise<EnsureCaptionsResult>;
  /** Turns captions back off — only if `ensureOn` was the one that turned them on. */
  restore(): Promise<void>;
  /**
   * Switches captions off and on again. Meet only lays out its captions panel
   * when captions start, so this makes it re-layout with MeetNotes' styles.
   * Returns false if captions were off or the CC button couldn't be found.
   */
  restart(): Promise<boolean>;
}

export interface MeetCaptionsToggleDeps {
  readonly document: Document;
  readonly findCaptionRegion: (root: ParentNode) => Element | null;
  readonly selectors?: MeetUiSelectorConfig;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly logger?: Logger;
}

/** Locates Meet's captions toolbar button (selectors first, then the icon ligature). */
export function findCaptionsButton(doc: Document, selectors: MeetUiSelectorConfig = DEFAULT_MEET_UI_SELECTORS): HTMLElement | null {
  for (const selector of selectors.captionsButton) {
    const match = Array.from(doc.querySelectorAll<HTMLElement>(selector)).find((el) => !isInCaptionsUi(el));
    if (match) return match;
  }
  for (const icon of Array.from(doc.querySelectorAll(selectors.iconElements))) {
    if (selectors.captionsIconTexts.includes(icon.textContent?.trim() ?? '')) {
      const button = icon.closest<HTMLElement>('button, [role="button"]');
      if (button && !isInCaptionsUi(button)) return button;
    }
  }
  return null;
}

/** Clicks Meet's own captions button — exactly what the user would do by hand. */
/**
 * Items inside the popup that newer Meet versions open from the CC button
 * ("Live captions" / "Translate speech"). Only items that were NOT already
 * rendered before the click are considered, so toolbar buttons (mic, camera…)
 * can never be clicked by mistake.
 */
const POPUP_TOGGLE_ITEMS =
  '[role="menuitemcheckbox"], [role="menuitemradio"], [role="switch"], [aria-pressed], [aria-checked]';

/** How long to wait for a direct toggle before looking for Meet's captions popup. */
const DIRECT_TOGGLE_WAIT_MS = 1200;

/** Clicks Meet's own captions controls — exactly what the user would do by hand. */
export class MeetCaptionsToggle implements CaptionsToggle {
  private turnedOnByUs = false;
  private readonly logger: Logger;

  constructor(private readonly deps: MeetCaptionsToggleDeps) {
    this.logger = deps.logger ?? createLogger('captions-toggle');
  }

  async ensureOn(): Promise<EnsureCaptionsResult> {
    if (this.captionsOn()) return 'already-on';
    const result = await this.switchCaptions(true);
    if (result === 'switched') {
      this.turnedOnByUs = true;
      this.logger.info('captions.turned-on');
      return 'turned-on';
    }
    this.logger.warn('captions.turn-on-failed', { result });
    return result;
  }

  async restore(): Promise<void> {
    if (!this.turnedOnByUs) return;
    this.turnedOnByUs = false;
    if (!this.captionsOn()) return; // user already turned them off
    const result = await this.switchCaptions(false);
    this.logger.info('captions.restored-off', { result });
  }

  async restart(): Promise<boolean> {
    if (!this.captionsOn()) return false;
    const off = await this.switchCaptions(false);
    if (off !== 'switched') {
      this.logger.warn('captions.restart-off-failed', { result: off });
      return false;
    }
    const on = await this.switchCaptions(true);
    this.logger.info('captions.restarted', { ok: on === 'switched' });
    return on === 'switched';
  }

  private captionsOn(): boolean {
    return this.deps.findCaptionRegion(this.deps.document) !== null;
  }

  /**
   * Turns captions on/off with Meet's CC button. Older Meet toggles directly;
   * newer Meet opens a popup ("Live captions" / "Translate speech") — then the
   * first toggle item that newly appeared ("Live captions") is used, and the
   * popup is closed again either way so no Meet UI is left open.
   */
  private async switchCaptions(wantOn: boolean): Promise<'switched' | 'no-button' | 'timed-out'> {
    const doc = this.deps.document;
    const button = findCaptionsButton(doc, this.deps.selectors);
    if (!button) return 'no-button';
    const reached = (): boolean => this.captionsOn() === wantOn;

    const before = new Set(Array.from(doc.querySelectorAll(POPUP_TOGGLE_ITEMS)).filter(isRendered));
    button.click();
    if (await this.waitFor(reached, Math.min(DIRECT_TOGGLE_WAIT_MS, this.timeoutMs()))) return 'switched';

    const item = Array.from(doc.querySelectorAll<HTMLElement>(POPUP_TOGGLE_ITEMS)).find(
      (el) => el !== button && !button.contains(el) && !before.has(el) && isRendered(el),
    );
    if (item) {
      this.logger.debug('captions.popup-item', { pressed: item.getAttribute('aria-pressed') ?? item.getAttribute('aria-checked') });
      item.click();
    }
    const ok = item !== undefined && (await this.waitFor(reached, this.timeoutMs()));
    this.closePopup(button);
    return ok ? 'switched' : 'timed-out';
  }

  /** Close Meet's captions popup if one is open (Escape, like a user would). */
  private closePopup(button: HTMLElement): void {
    const doc = this.deps.document;
    const escape = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true } as const;
    (doc.activeElement ?? doc.body).dispatchEvent(new KeyboardEvent('keydown', escape));
    if (button.getAttribute('aria-expanded') === 'true') button.click();
  }

  private timeoutMs(): number {
    return this.deps.timeoutMs ?? 3000;
  }

  private async waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (condition()) return true;
      await new Promise((resolve) => setTimeout(resolve, this.deps.pollMs ?? 150));
    }
    return condition();
  }
}
