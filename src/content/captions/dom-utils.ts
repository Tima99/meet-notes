import { normalizeCaptionText } from './text-utils';

/** Icon-font glyphs render ligature words like "arrow_downward" as text. */
export const ICON_SELECTOR = 'i, .google-symbols, .material-icons, .material-icons-extended, .material-symbols-outlined';
export const ICON_LIGATURE = /^[a-z0-9]+(?:_[a-z0-9]+)+$/;
/** Interactive controls. */
export const INTERACTIVE_SELECTOR = 'button, [role="button"], a[href], input, select';

/** Text of an element as a user reads it: icon-font glyph words removed. */
export function visibleText(element: Element): string {
  if (!element.querySelector(ICON_SELECTOR)) return normalizeCaptionText(element.textContent);
  const clone = element.cloneNode(true) as Element;
  for (const icon of Array.from(clone.querySelectorAll(ICON_SELECTOR))) icon.remove();
  return normalizeCaptionText(clone.textContent);
}

/**
 * Rendered (not display:none / visibility:hidden / [hidden] anywhere up the tree)?
 * Size is deliberately ignored: things inside MeetNotes' collapsed captions
 * panel are clipped but still rendered and usable.
 */
export function isRendered(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  for (let el: Element | null = element; el; el = el.parentElement) {
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
    const style = view?.getComputedStyle(el);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  }
  return true;
}
