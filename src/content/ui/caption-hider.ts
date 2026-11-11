/**
 * Hides Meet's whole captions panel (caption text, language picker, font and
 * settings buttons) and gives its space back to the video grid — Meet looks as
 * if captions were off.
 *
 * The panel is collapsed to zero height rather than `display: none`: it stays
 * rendered, so Meet keeps writing caption text into it and the observer keeps
 * working. `show()` restores it exactly.
 *
 * Meet does not re-measure its overlays continuously (diagnostics showed it still
 * positioning controls 216px higher after the panel collapsed), so after every
 * change we fire the same `resize` event the browser sends when the window is
 * resized, which makes Meet recompute its layout with the panel's new height.
 */
import { createLogger, type Logger } from '../../shared/logger';
import { DEFAULT_CAPTION_SELECTORS, type CaptionSelectorConfig } from '../captions/selectors';
import { describeElement, findCaptionPanel } from '../meet/caption-panel';

export const HIDDEN_ATTR = 'data-meetnotes-hidden';
/** Set on <html> while hidden-captions mode is active. */
export const MODE_ATTR = 'data-meetnotes-captions-hidden';
const STYLE_ID = 'meetnotes-caption-hider';
/** Meet may debounce/animate its layout; nudge a few times. */
const RELAYOUT_DELAYS_MS = [0, 150, 500, 1200];

const COLLAPSE = `
  height: 0 !important;
  min-height: 0 !important;
  max-height: 0 !important;
  flex: 0 0 0px !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  overflow: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;`;

/**
 * Collapse the panel, its direct children (language bar, caption wrapper) and
 * the elements Meet sizes the layout from. Known selectors are applied by
 * stylesheet as soon as the mode is on — BEFORE captions are turned on — so Meet
 * never measures a full-height panel. The attribute rules cover panels found
 * by the structural fallback.
 */
export function buildHiderCss(selectors: CaptionSelectorConfig = DEFAULT_CAPTION_SELECTORS): string {
  const inPanel = (panel: string): string[] => [panel, `${panel} > div`, ...selectors.panelSizers.map((s) => `${panel} ${s}`)];
  const targets = [
    ...selectors.panel.flatMap((p) => inPanel(`html[${MODE_ATTR}] ${p}`)),
    ...inPanel(`[${HIDDEN_ATTR}]`),
  ];
  return `${targets.join(',\n')} {${COLLAPSE}\n}`;
}

export interface CaptionHider {
  /** Turn hidden-captions mode on (safe to call before captions exist). */
  prepare(): void;
  hide(region: Element): void;
  show(): void;
}

export class CssCaptionHider implements CaptionHider {
  private target: Element | null = null;
  private relayoutTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private readonly doc: Document,
    private readonly logger: Logger = createLogger('caption-hider'),
  ) {}

  prepare(): void {
    if (!this.doc.getElementById(STYLE_ID)) {
      const style = this.doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = buildHiderCss();
      (this.doc.head ?? this.doc.documentElement).append(style);
    }
    this.doc.documentElement.setAttribute(MODE_ATTR, '');
  }

  hide(region: Element): void {
    this.prepare();
    const panel = findCaptionPanel(region);
    if (this.target === panel && panel.hasAttribute(HIDDEN_ATTR)) return;
    this.target?.removeAttribute(HIDDEN_ATTR);
    panel.setAttribute(HIDDEN_ATTR, '');
    this.target = panel;
    this.logger.info('panel.hidden', { element: describeElement(panel), isRegionItself: panel === region });
    this.requestRelayout();
  }

  show(): void {
    const wasActive = this.doc.documentElement.hasAttribute(MODE_ATTR);
    this.doc.documentElement.removeAttribute(MODE_ATTR);
    this.target?.removeAttribute(HIDDEN_ATTR);
    this.target = null;
    this.doc.getElementById(STYLE_ID)?.remove();
    if (wasActive) this.requestRelayout();
  }

  /** Ask Meet to recompute its layout (it re-measures on window resize). */
  private requestRelayout(): void {
    for (const timer of this.relayoutTimers) clearTimeout(timer);
    const view = this.doc.defaultView;
    if (!view) return;
    this.relayoutTimers = RELAYOUT_DELAYS_MS.map((delay) =>
      setTimeout(() => view.dispatchEvent(new Event('resize')), delay),
    );
  }
}
