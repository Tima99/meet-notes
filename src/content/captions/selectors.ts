/**
 * CRITICAL DOM DEPENDENCY.
 *
 * Google Meet's markup is obfuscated and changes without notice. Every selector the
 * extension relies on lives here, ordered from most to least specific. When Meet
 * ships a new DOM, this is the only file that should need editing.
 *
 * If no `block` selector matches, the parser falls back to a structural heuristic
 * (each caption block = [speaker element, text element]), so captions keep working
 * even after class names rotate.
 */
export interface CaptionSelectorConfig {
  /** The live-captions container. First match wins. */
  readonly region: readonly string[];
  /**
   * The whole captions panel (language bar + caption region) whose height Meet
   * reserves under the video grid. Collapsed in hidden-captions mode.
   */
  readonly panel: readonly string[];
  /**
   * Elements inside the panel whose own size Meet uses to reserve layout space
   * (the absolutely-positioned caption scroller keeps its 204px even when the
   * panel is collapsed, so it must be collapsed too).
   */
  readonly panelSizers: readonly string[];
  /** One block per speaker turn, inside the region. */
  readonly block: readonly string[];
  /** Speaker name element, inside a block. */
  readonly speaker: readonly string[];
  /** Caption text element, inside a block. */
  readonly text: readonly string[];
}

/*
 * Verified against live Meet on 2026-11-11 (layout diagnostics):
 *
 *   div.fJsklc[jscontroller=hVZhab] style="bottom: 80px"   ← stacked overlay host above the toolbar
 *     div[jscontroller=D1tHje]
 *       div.a4cQT                                         ← captions PANEL (216px reserved)
 *         div.NmXUuc[jscontroller=rRafu]                  ← language picker bar
 *         div.DtJ7e > div.iOzk7[jsname=dsyhDe]
 *           div.vNKgIf[role=region][aria-label=Captions][jscontroller=KPn5nb]   ← REGION
 *             div.nMcdL                                   ← BLOCK
 *               div.adE6rb > img + div.KcIKyf > span.NWpY1d   ← SPEAKER
 *               div.ygicle                                ← TEXT
 *             div.IMKgW > button                          ← "Jump to bottom" (not a caption)
 */
export const DEFAULT_CAPTION_SELECTORS: CaptionSelectorConfig = {
  region: [
    'div[role="region"][aria-label="Captions"]',
    'div.vNKgIf[role="region"]', // aria-label is localized; class + controller are not
    'div[role="region"][jscontroller="KPn5nb"]',
    'div[jsname="dsyhDe"]',
    'div.a4cQT',
    'div[role="region"][tabindex="0"]',
  ],
  panel: ['div.a4cQT'],
  panelSizers: ['div[jsname="dsyhDe"]', 'div.iOzk7', 'div.NmXUuc'],
  block: ['div.nMcdL', 'div.TBMuR'],
  speaker: ['.NWpY1d', '.KcIKyf', '.zs7s8d'],
  text: ['.ygicle', '.bh44bd', '.iTTPOb'],
};

export interface MeetUiSelectorConfig {
  /** Present only while the user is in a call. */
  readonly leaveCallButton: readonly string[];
  /** Material Symbols ligature text of the leave-call icon (not localized). */
  readonly leaveCallIconText: string;
  readonly iconElements: string;
  /** The toolbar "Turn on/off captions" button. */
  readonly captionsButton: readonly string[];
  /** Material Symbols ligatures used by the captions button icon (not localized). */
  readonly captionsIconTexts: readonly string[];
}

export const DEFAULT_MEET_UI_SELECTORS: MeetUiSelectorConfig = {
  leaveCallButton: ['button[jsname="CQylAd"]', 'button[aria-label="Leave call"]'],
  leaveCallIconText: 'call_end',
  iconElements: 'i.google-symbols, i.material-icons-extended, i.google-material-icons',
  // Never matched inside the captions panel itself (its "Jump to bottom" button
  // can mention captions too) — see findCaptionsButton().
  captionsButton: [
    'button[jsname="r8qRAd"]',
    'button[aria-label^="Turn on captions" i]',
    'button[aria-label^="Turn off captions" i]',
    'button[aria-label*="captions" i]',
  ],
  captionsIconTexts: ['closed_caption', 'closed_caption_off', 'subtitles', 'subtitles_off'],
};
