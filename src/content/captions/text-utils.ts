/**
 * Text helpers. These never change wording — they only collapse whitespace that
 * is an artifact of DOM layout (line breaks, nbsp, multiple spaces).
 */
export function normalizeCaptionText(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(/[\s ]+/g, ' ').trim();
}

export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/**
 * Returns `index` if it already sits on a word boundary, otherwise moves it back
 * to the start of the word it falls inside — so a split never cuts a word in half.
 */
export function snapToWordBoundary(text: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;
  if (text[index] === ' ' || text[index - 1] === ' ') return index;
  const space = text.lastIndexOf(' ', index - 1);
  return space === -1 ? 0 : space + 1;
}

/** Joins two already-normalized fragments with a single space. */
export function joinText(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a} ${b}`;
}
