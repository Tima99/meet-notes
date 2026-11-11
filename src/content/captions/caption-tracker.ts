import { randomId, type IdFactory } from '../../shared/clock';
import { createLogger, type Logger } from '../../shared/logger';
import type { SegmentStatus, TranscriptSegment } from '../../shared/types';
import type { CaptionBlockSnapshot } from './caption-observer';
import { commonPrefixLength, joinText, normalizeCaptionText } from './text-utils';

/**
 * CaptionTracker — turns a stream of caption snapshots into transcript segments.
 *
 * Pure logic: no DOM, no timers, no chrome APIs. Time is passed in explicitly.
 *
 * Core rule: ONE caption block on screen = ONE segment. Everything Meet does to
 * that block (growing, correcting words anywhere in the sentence, dropping old
 * sentences) updates the same segment id. A segment becomes `final` once the
 * block is stable; if Meet corrects the block afterwards, the segment is amended
 * in place (higher `revision`), never duplicated.
 *
 * How Meet behaves (and how each behaviour is handled):
 *  - Text grows word by word; words get corrected, even mid-sentence
 *    →  `revised`: update in place.
 *  - Long blocks drop their oldest sentences  →  `slid`: the dropped text is
 *    carried into the segment so nothing is lost.
 *  - A block is cleared and restarted with unrelated text  →  `reset`: the old
 *    segment is closed and a new one starts.
 *  - Old blocks scroll out of the DOM  →  they become "retired" (finalized after a
 *    short grace period) but are remembered for a while.
 *  - The caption list is re-rendered with NEW elements (layout change, captions
 *    restarted) — sometimes already rewritten by Meet  →  the new element re-adopts
 *    the retired block's segment instead of duplicating it. A re-rendered element
 *    appears holding a long text at once, while genuine new speech starts with a
 *    word or two, which is how the two are told apart.
 */

export interface CaptionTrackerOptions {
  readonly meetingId: string;
  /** Finalize the newest block's segment after this long without changes. */
  readonly idleFinalizeMs: number;
  /** Finalize a block that has a newer block below it after this long without changes. */
  readonly supersededFinalizeMs: number;
  /** A vanished block stays open this long (a re-render usually re-adopts it at once). */
  readonly vanishGraceMs: number;
  /** How long a vanished block is remembered for re-adoption by a re-rendered element. */
  readonly retainVanishedMs: number;
  /**
   * After the grace period, only an element that appears already holding at least
   * this much text can re-adopt (short texts like "Yes." are treated as new speech).
   */
  readonly minDedupeChars: number;
  /** Minimum overlap to recognise a "slide" (oldest text dropped from a block). */
  readonly minSlideOverlapChars: number;
  /** Text shorter than this is still unstable: Meet may rewrite it entirely. */
  readonly unstablePrefixChars: number;
  /** A block shrinking below this ratio of its previous length is treated as a reset. */
  readonly maxShrinkRatio: number;
  /** Share of the previous words that must survive (in order) for a change to count as a correction. */
  readonly minWordOverlap: number;
}

export const DEFAULT_TRACKER_OPTIONS: Omit<CaptionTrackerOptions, 'meetingId'> = {
  idleFinalizeMs: 5000,
  supersededFinalizeMs: 2000,
  vanishGraceMs: 1500,
  retainVanishedMs: 120_000,
  minDedupeChars: 20,
  minSlideOverlapChars: 12,
  unstablePrefixChars: 20,
  maxShrinkRatio: 0.6,
  minWordOverlap: 0.5,
};

export type SegmentChange = 'created' | 'updated' | 'finalized';

export interface TrackerEvent {
  readonly change: SegmentChange;
  readonly segment: TranscriptSegment;
}

export type TrackerListener = (event: TrackerEvent) => void;

// ── text change classification ─────────────────────────────────────────────

export type TextChange =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'revised' }
  | { readonly kind: 'slid'; readonly dropLength: number }
  | { readonly kind: 'reset' };

type ClassifyOptions = Pick<
  CaptionTrackerOptions,
  'minSlideOverlapChars' | 'unstablePrefixChars' | 'maxShrinkRatio' | 'minWordOverlap'
>;

/** Decides how a block's text moved from `prev` to `next`. */
export function classifyChange(prev: string, next: string, options: ClassifyOptions): TextChange {
  if (prev === next) return { kind: 'unchanged' };
  if (!prev) return { kind: 'revised' };

  const shrankHard = prev.length >= options.unstablePrefixChars && next.length < prev.length * options.maxShrinkRatio;

  // Fast path: growth or a correction near the end.
  const prefix = commonPrefixLength(prev, next);
  const shorter = Math.min(prev.length, next.length);
  if (!shrankHard && shorter > 0 && prefix >= shorter * 0.5) return { kind: 'revised' };

  // Oldest sentences dropped. Checked before the word overlap so dropped text is never lost.
  const dropLength = findSlide(prev, next, options.minSlideOverlapChars);
  if (dropLength !== null) return { kind: 'slid', dropLength };

  // Corrections anywhere in the sentence ("There, usually" → "They're usually").
  if (!shrankHard && wordOverlapRatio(prev, next) >= options.minWordOverlap) return { kind: 'revised' };

  if (!shrankHard && prev.length < options.unstablePrefixChars) return { kind: 'revised' };
  return { kind: 'reset' };
}

/**
 * If `next` starts somewhere inside `prev` (on a word boundary) and continues
 * it, returns how many leading characters of `prev` were dropped.
 */
export function findSlide(prev: string, next: string, minOverlap: number): number | null {
  if (next.length < minOverlap) return null;
  const probe = next.slice(0, minOverlap);
  let position = prev.indexOf(probe, 1);
  while (position !== -1) {
    if (prev[position - 1] === ' ') {
      const tail = prev.slice(position);
      const shared = commonPrefixLength(tail, next);
      if (shared >= minOverlap && shared >= Math.min(tail.length, next.length) * 0.5) return position;
    }
    position = prev.indexOf(probe, position + 1);
  }
  return null;
}

const MAX_COMPARED_WORDS = 400;

function comparableWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(' ')
    .map((word) => word.replace(/[^\p{L}\p{M}\p{N}']/gu, ''))
    .filter((word) => word.length > 0)
    .slice(0, MAX_COMPARED_WORDS);
}

/**
 * Share of `prev`'s words that still appear, in order, in `next`
 * (longest common subsequence over words, ignoring case and punctuation).
 */
export function wordOverlapRatio(prev: string, next: string): number {
  const a = comparableWords(prev);
  const b = comparableWords(next);
  if (a.length === 0) return 0;
  let row = new Uint16Array(b.length + 1);
  let previousRow = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    [row, previousRow] = [previousRow, row];
    for (let j = 1; j <= b.length; j++) {
      row[j] = a[i - 1] === b[j - 1] ? (previousRow[j - 1] ?? 0) + 1 : Math.max(previousRow[j] ?? 0, row[j - 1] ?? 0);
    }
  }
  return (row[b.length] ?? 0) / a.length;
}

// ── internal state ─────────────────────────────────────────────────────────

interface SegmentDraft {
  readonly id: string;
  readonly sequence: number;
  readonly startedAt: number;
  speaker: string;
  /** Text that has scrolled out of the block but belongs to this segment. */
  carried: string;
  text: string;
  lastSpokenAt: number;
  revision: number;
  /** False once finalized; flips back to true if Meet amends the block. */
  open: boolean;
}

interface BlockState {
  key: string;
  speaker: string;
  /** Last observed text of the DOM block. */
  lastText: string;
  /** The segment this block feeds (open or finalized). */
  segment: SegmentDraft | null;
  lastChangeAt: number;
}

/** A block whose element left the DOM; re-adoptable by a re-rendered element. */
interface Retired {
  readonly block: BlockState;
  readonly vanishedAt: number;
}

const MAX_RETIRED = 50;

export class CaptionTracker {
  private readonly blocks = new Map<string, BlockState>();
  private order: string[] = [];
  private retired: Retired[] = [];
  private sequence = 0;
  private readonly listeners = new Set<TrackerListener>();
  private readonly options: CaptionTrackerOptions;

  constructor(
    options: Pick<CaptionTrackerOptions, 'meetingId'> & Partial<CaptionTrackerOptions>,
    private readonly newId: IdFactory = randomId,
    private readonly logger: Logger = createLogger('tracker'),
  ) {
    this.options = { ...DEFAULT_TRACKER_OPTIONS, ...options };
  }

  subscribe(listener: TrackerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Number of segments created so far. */
  get segmentCount(): number {
    return this.sequence;
  }

  /** Feed the current list of visible caption blocks (in DOM order). */
  ingest(snapshot: readonly CaptionBlockSnapshot[], now: number): void {
    const present = new Set(snapshot.map((b) => b.key));

    // Vanished blocks first, so re-rendered elements in this same snapshot can adopt them.
    for (const [key, block] of this.blocks) {
      if (!present.has(key)) {
        this.blocks.delete(key);
        if (block.lastText) this.retired.push({ block, vanishedAt: now });
      }
    }
    if (this.retired.length > MAX_RETIRED) {
      for (const old of this.retired.splice(0, this.retired.length - MAX_RETIRED)) this.close(old.block, now);
    }

    for (const raw of snapshot) {
      const snap = { ...raw, text: normalizeCaptionText(raw.text), speaker: normalizeCaptionText(raw.speaker) };
      const existing = this.blocks.get(snap.key);
      if (existing) this.applyText(existing, snap, now);
      else this.addBlock(snap, now);
    }

    this.order = snapshot.map((b) => b.key);
    this.tick(now);
  }

  /** Time-based finalization. Call periodically (e.g. every 500 ms). */
  tick(now: number): void {
    for (const { block, vanishedAt } of this.retired) {
      if (now - vanishedAt >= this.options.vanishGraceMs) this.close(block, now);
    }
    this.retired = this.retired.filter((r) => now - r.vanishedAt < this.options.retainVanishedMs);

    const lastIndex = this.order.length - 1;
    this.order.forEach((key, index) => {
      const block = this.blocks.get(key);
      if (!block?.segment?.open) return;
      const threshold = index < lastIndex ? this.options.supersededFinalizeMs : this.options.idleFinalizeMs;
      if (now - block.lastChangeAt >= threshold) this.close(block, now);
    });
  }

  /**
   * Finalize everything (stop / captions turned off). Block identities are kept,
   * so if the same elements reappear their text is not duplicated.
   */
  flush(now: number): void {
    for (const { block } of this.retired) this.close(block, now);
    for (const block of this.blocks.values()) this.close(block, now);
  }

  // ── block lifecycle ──────────────────────────────────────────────────────

  private addBlock(snap: CaptionBlockSnapshot, now: number): void {
    const block = this.adoptRetired(snap, now) ?? this.newBlock(snap, now);
    block.key = snap.key;
    this.blocks.set(snap.key, block);
    this.applyText(block, snap, now);
  }

  private newBlock(snap: CaptionBlockSnapshot, now: number): BlockState {
    return { key: snap.key, speaker: snap.speaker, lastText: '', segment: null, lastChangeAt: now };
  }

  /**
   * Is this new element a re-render of a block we already know? Same speaker, and:
   *  - within the grace period: same or extended/shortened text (any length), or
   *  - any time within the retention window: it appeared already holding a long
   *    text that is the same sentence (Meet may have rewritten words meanwhile).
   * Most recently vanished first.
   */
  private adoptRetired(snap: CaptionBlockSnapshot, now: number): BlockState | null {
    if (!snap.text) return null;
    for (let i = this.retired.length - 1; i >= 0; i--) {
      const candidate = this.retired[i];
      if (!candidate) continue;
      const { block, vanishedAt } = candidate;
      if (block.speaker !== snap.speaker) continue;
      const prefixRelated = snap.text.startsWith(block.lastText) || block.lastText.startsWith(snap.text);
      const withinGrace = now - vanishedAt <= this.options.vanishGraceMs;
      const longEnough = snap.text.length >= this.options.minDedupeChars;
      const sameSentence =
        longEnough && (prefixRelated || classifyChange(block.lastText, snap.text, this.options).kind !== 'reset');
      if ((withinGrace && prefixRelated) || sameSentence) {
        this.retired.splice(i, 1);
        this.logger.debug('block.re-adopted', { key: snap.key, previousKey: block.key, withinGrace });
        return block;
      }
    }
    return null;
  }

  private applyText(block: BlockState, snap: CaptionBlockSnapshot, now: number): void {
    const speakerChanged = snap.speaker !== block.speaker;
    if (speakerChanged) {
      block.speaker = snap.speaker;
      if (block.segment) block.segment.speaker = snap.speaker;
    }

    const prev = block.lastText;
    const next = snap.text;
    if (prev === next) {
      if (speakerChanged && block.segment) this.emit(block.segment.open ? 'updated' : 'finalized', block.segment, now);
      return;
    }

    const change = classifyChange(prev, next, this.options);
    if (change.kind === 'slid') {
      this.applySlide(block, change.dropLength);
    } else if (change.kind === 'reset') {
      this.close(block, now);
      block.segment = null;
    }
    block.lastText = next;
    block.lastChangeAt = now;
    this.syncSegment(block, now, speakerChanged);
  }

  /** The block dropped its first `dropLength` chars: keep them in the segment's `carried` text. */
  private applySlide(block: BlockState, dropLength: number): void {
    const dropped = normalizeCaptionText(block.lastText.slice(0, dropLength));
    if (block.segment) block.segment.carried = joinText(block.segment.carried, dropped);
  }

  private syncSegment(block: BlockState, now: number, force: boolean): void {
    const tail = block.lastText;
    const segment = block.segment;

    if (!segment) {
      if (!tail) return;
      block.segment = {
        id: this.newId(),
        sequence: ++this.sequence,
        startedAt: now,
        speaker: block.speaker,
        carried: '',
        text: tail,
        lastSpokenAt: now,
        revision: 0,
        open: true,
      };
      this.emit('created', block.segment, now);
      return;
    }

    const text = joinText(segment.carried, tail);
    if (!text) return; // never blank out a segment
    const textChanged = text !== segment.text;
    if (!textChanged && !force) return;
    if (textChanged) {
      segment.text = text;
      segment.lastSpokenAt = now;
      if (!segment.open) this.logger.debug('segment.amended', { id: segment.id });
      segment.open = true; // Meet corrected a finalized caption: amend it, same id
    }
    this.emit(segment.open ? 'updated' : 'finalized', segment, now);
  }

  private close(block: BlockState, now: number): void {
    const segment = block.segment;
    if (!segment?.open) return;
    segment.open = false;
    this.emit('finalized', segment, now);
  }

  // ── output ───────────────────────────────────────────────────────────────

  private emit(change: SegmentChange, draft: SegmentDraft, now: number): void {
    draft.revision += 1;
    const status: SegmentStatus = draft.open ? 'interim' : 'final';
    const segment: TranscriptSegment = {
      id: draft.id,
      meetingId: this.options.meetingId,
      sequence: draft.sequence,
      speaker: draft.speaker,
      text: draft.text,
      startedAt: draft.startedAt,
      lastSpokenAt: draft.lastSpokenAt,
      finalizedAt: status === 'final' ? now : null,
      revision: draft.revision,
      status,
    };
    for (const listener of this.listeners) {
      try {
        listener({ change, segment });
      } catch (error) {
        this.logger.error('listener.failed', { error, change });
      }
    }
  }
}
