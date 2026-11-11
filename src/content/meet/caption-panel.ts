import {
  DEFAULT_CAPTION_SELECTORS,
  DEFAULT_MEET_UI_SELECTORS,
  type CaptionSelectorConfig,
  type MeetUiSelectorConfig,
} from '../captions/selectors';

/**
 * Meet's captions UI is more than the caption text: a panel holds the text
 * region plus the language picker and font/settings buttons, and reserves space
 * under the video grid.
 *
 * Finding it without relying on obfuscated class names: climb from the caption
 * region while the parent still holds *only* captions UI. Stop before any
 * ancestor that also contains participant tiles, video, or the call toolbar —
 * so we can never hide the meeting itself.
 */
const MAX_CLIMB = 6;
const MEETING_CONTENT = 'video, [data-participant-id], [data-requested-participant-id], [data-self-name]';

/**
 * Does this element hold any part of the meeting itself? (Tiles, video, or the
 * call toolbar — recognised by its leave-call / CC icons, which are not localized.
 * Aria-label matching is deliberately NOT used: buttons inside the captions panel
 * can mention "captions" too.)
 */
function containsMeetingChrome(element: Element, selectors: MeetUiSelectorConfig): boolean {
  if (element.querySelector(MEETING_CONTENT)) return true;
  for (const selector of selectors.leaveCallButton) {
    if (element.querySelector(selector)) return true;
  }
  for (const icon of Array.from(element.querySelectorAll(selectors.iconElements))) {
    const text = icon.textContent?.trim() ?? '';
    if (text === selectors.leaveCallIconText || selectors.captionsIconTexts.includes(text)) return true;
  }
  return false;
}

export function findCaptionPanel(
  region: Element,
  selectors: MeetUiSelectorConfig = DEFAULT_MEET_UI_SELECTORS,
  captionSelectors: CaptionSelectorConfig = DEFAULT_CAPTION_SELECTORS,
): Element {
  for (const selector of captionSelectors.panel) {
    const known = region.closest(selector);
    if (known && known !== region && !containsMeetingChrome(known, selectors)) return known;
  }
  const doc = region.ownerDocument;
  let panel = region;
  for (let depth = 0; depth < MAX_CLIMB; depth++) {
    const parent = panel.parentElement;
    if (!parent || parent === doc.body || parent === doc.documentElement) break;
    if (containsMeetingChrome(parent, selectors)) break;
    panel = parent;
  }
  return panel;
}

/** Short structural description for logs (never includes caption text). */
export function describeElement(element: Element): string {
  const role = element.getAttribute('role');
  const jsname = element.getAttribute('jsname');
  const classes = Array.from(element.classList).slice(0, 3).join('.');
  return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ''}${role ? `[role=${role}]` : ''}${jsname ? `[jsname=${jsname}]` : ''}`;
}
