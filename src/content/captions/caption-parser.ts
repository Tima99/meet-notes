import { createLogger, type Logger } from '../../shared/logger';
import { DEFAULT_CAPTION_SELECTORS, type CaptionSelectorConfig } from './selectors';
import { ICON_LIGATURE, ICON_SELECTOR, INTERACTIVE_SELECTOR, visibleText } from './dom-utils';
import { normalizeCaptionText } from './text-utils';

export interface ParsedCaptionBlock {
  readonly element: Element;
  readonly speaker: string;
  readonly text: string;
}

export interface CaptionParser {
  findRegion(root: ParentNode): Element | null;
  parseBlocks(region: Element): ParsedCaptionBlock[];
}

export const UNKNOWN_SPEAKER = 'Unknown speaker';
const MAX_SPEAKER_NAME_LENGTH = 80;
const MAX_STRUCTURAL_DEPTH = 4;

type Strategy = 'selectors' | 'structural' | 'none';

/** Extracts caption blocks from Meet's captions DOM. Pure DOM reads, no side effects. */
export class MeetCaptionParser implements CaptionParser {
  private lastStrategy: Strategy | null = null;

  constructor(
    private readonly selectors: CaptionSelectorConfig = DEFAULT_CAPTION_SELECTORS,
    private readonly logger: Logger = createLogger('parser'),
  ) {}

  findRegion(root: ParentNode): Element | null {
    for (const selector of this.selectors.region) {
      const match = root.querySelector(selector);
      if (match) return match;
    }
    return null;
  }

  parseBlocks(region: Element): ParsedCaptionBlock[] {
    let strategy: Strategy = 'selectors';
    let blocks = this.parseWithSelectors(region);
    if (blocks === null) {
      strategy = 'structural';
      blocks = this.parseStructurally(region);
    }
    if (strategy === 'structural' && blocks.length === 0) strategy = 'none';
    this.reportStrategy(strategy, blocks.length);
    return inheritMissingSpeakers(blocks);
  }

  /** Returns null when no block selector matches (so the caller can fall back). */
  private parseWithSelectors(region: Element): ParsedCaptionBlock[] | null {
    for (const blockSelector of this.selectors.block) {
      const elements = Array.from(region.querySelectorAll(blockSelector));
      if (elements.length === 0) continue;
      const parsed: ParsedCaptionBlock[] = [];
      for (const element of elements) {
        const block = this.parseKnownBlock(element);
        if (block) parsed.push(block);
      }
      return parsed;
    }
    return null;
  }

  private parseKnownBlock(element: Element): ParsedCaptionBlock | null {
    const textEl = queryFirst(element, this.selectors.text);
    const speakerEl = queryFirst(element, this.selectors.speaker);
    if (!textEl) return parseStructuralBlock(element);
    const text = normalizeCaptionText(textEl.textContent);
    if (!text) return null;
    return { element, speaker: normalizeCaptionText(speakerEl?.textContent), text };
  }

  /**
   * Fallback: walk down the region looking for a level whose children parse as
   * [speaker, text] blocks. Descends into the child holding the most text.
   */
  private parseStructurally(region: Element): ParsedCaptionBlock[] {
    let container: Element | null = region;
    for (let depth = 0; container && depth < MAX_STRUCTURAL_DEPTH; depth++) {
      const children: Element[] = Array.from(container.children);
      const parsed = children.map(parseStructuralBlock).filter((b): b is ParsedCaptionBlock => b !== null);
      if (parsed.length > 0) return parsed;
      container = largestTextChild(children);
    }
    return [];
  }

  private reportStrategy(strategy: Strategy, count: number): void {
    if (strategy === this.lastStrategy) return;
    this.lastStrategy = strategy;
    const log = strategy === 'structural' ? this.logger.warn : this.logger.debug;
    log('strategy.changed', { strategy, blocks: count });
  }
}

function queryFirst(root: Element, selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    const match = root.querySelector(selector);
    if (match) return match;
  }
  return null;
}

/** Skips through wrapper elements that have exactly one element child and no own text. */
function unwrap(element: Element): Element {
  let current = element;
  while (current.children.length === 1 && !hasOwnText(current)) {
    const only = current.firstElementChild;
    if (!only) break;
    current = only;
  }
  return current;
}

function hasOwnText(element: Element): boolean {
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3 /* TEXT_NODE */ && normalizeCaptionText(node.textContent)) return true;
  }
  return false;
}

/** A structural block is an element whose (unwrapped) children are [speaker, ...text]. */
function parseStructuralBlock(element: Element): ParsedCaptionBlock | null {
  // Controls inside the captions region (e.g. "Jump to bottom") are never captions.
  if (element.matches(INTERACTIVE_SELECTOR) || element.querySelector(INTERACTIVE_SELECTOR)) return null;
  const inner = unwrap(element);
  const parts = Array.from(inner.children)
    .filter((child) => !child.matches(ICON_SELECTOR))
    .map(visibleText)
    .filter((text) => text.length > 0);
  if (parts.length < 2) return null;
  const [speaker, ...rest] = parts;
  if (!speaker || speaker.length > MAX_SPEAKER_NAME_LENGTH || ICON_LIGATURE.test(speaker)) return null;
  const text = rest.join(' ');
  return text ? { element, speaker, text } : null;
}

function largestTextChild(children: readonly Element[]): Element | null {
  let best: Element | null = null;
  let bestLength = 0;
  for (const child of children) {
    const length = (child.textContent ?? '').length;
    if (length > bestLength) {
      best = child;
      bestLength = length;
    }
  }
  return best;
}

/** Meet occasionally omits the name on a continuation block; reuse the previous speaker. */
function inheritMissingSpeakers(blocks: readonly ParsedCaptionBlock[]): ParsedCaptionBlock[] {
  let previous = UNKNOWN_SPEAKER;
  return blocks.map((block) => {
    if (block.speaker) {
      previous = block.speaker;
      return block;
    }
    return { ...block, speaker: previous };
  });
}
