import type { Clock } from '../../shared/clock';
import { createLogger, type Logger } from '../../shared/logger';
import type { CaptionParser } from './caption-parser';

/** One visible caption block. `key` is stable for the lifetime of the DOM element. */
export interface CaptionBlockSnapshot {
  readonly key: string;
  readonly speaker: string;
  readonly text: string;
}

export type CaptionObserverEvent =
  | { readonly kind: 'region-found'; readonly at: number }
  | { readonly kind: 'region-lost'; readonly at: number }
  | { readonly kind: 'snapshot'; readonly blocks: readonly CaptionBlockSnapshot[]; readonly at: number };

export type CaptionObserverListener = (event: CaptionObserverEvent) => void;

export interface CaptionObserverOptions {
  /** Delay before re-locating the region when it is missing (captions off / not yet rendered). */
  readonly searchDelayMs: number;
  /** Delay before re-validating an attached region (cheap; catches Meet swapping containers). */
  readonly revalidateDelayMs: number;
}

export const DEFAULT_OBSERVER_OPTIONS: CaptionObserverOptions = { searchDelayMs: 250, revalidateDelayMs: 1000 };

export interface CaptionObserverDeps {
  readonly document: Document;
  readonly parser: CaptionParser;
  readonly clock: Clock;
  readonly logger?: Logger;
}

/**
 * Watches Meet's DOM and turns caption mutations into snapshots.
 *
 * Two MutationObservers:
 *  - a cheap document-level one whose only job is to notice the captions region
 *    appearing, disappearing or being replaced (coalesced via a timer), and
 *  - a region-level one (childList + characterData, subtree) that produces a
 *    snapshot on every caption change. MutationObserver callbacks are not
 *    throttled in background tabs, so captions keep flowing when Meet is hidden.
 *
 * Identical consecutive snapshots are suppressed.
 */
export class CaptionObserver {
  private listener: CaptionObserverListener | null = null;
  private region: Element | null = null;
  private regionObserver: MutationObserver | null = null;
  private documentObserver: MutationObserver | null = null;
  private relocateTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly keys = new WeakMap<Element, string>();
  private nextKey = 1;
  private lastSignature: string | null = null;
  private readonly logger: Logger;
  private readonly options: CaptionObserverOptions;

  constructor(
    private readonly deps: CaptionObserverDeps,
    options: Partial<CaptionObserverOptions> = {},
  ) {
    this.logger = deps.logger ?? createLogger('observer');
    this.options = { ...DEFAULT_OBSERVER_OPTIONS, ...options };
  }

  get isRunning(): boolean {
    return this.listener !== null;
  }

  get hasRegion(): boolean {
    return this.region !== null;
  }

  /** The captions container currently being observed. */
  get regionElement(): Element | null {
    return this.region;
  }

  start(listener: CaptionObserverListener): void {
    if (this.listener) {
      this.logger.warn('start.ignored', { reason: 'already running' });
      return;
    }
    this.listener = listener;
    const doc = this.deps.document;
    this.documentObserver = new MutationObserver(() => this.scheduleRelocate());
    this.documentObserver.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true });
    this.relocate();
    this.logger.info('started', { regionFound: this.region !== null });
  }

  stop(): void {
    this.documentObserver?.disconnect();
    this.documentObserver = null;
    this.detachRegion();
    if (this.relocateTimer !== null) clearTimeout(this.relocateTimer);
    this.relocateTimer = null;
    this.listener = null;
    this.lastSignature = null;
    this.logger.info('stopped');
  }

  /** Forces a snapshot now (e.g. right after start). */
  refresh(): void {
    this.lastSignature = null;
    this.relocate();
    this.snapshot();
  }

  private scheduleRelocate(): void {
    if (this.relocateTimer !== null || !this.listener) return;
    const attached = this.region?.isConnected === true;
    const delay = attached ? this.options.revalidateDelayMs : this.options.searchDelayMs;
    this.relocateTimer = setTimeout(() => {
      this.relocateTimer = null;
      this.relocate();
    }, delay);
  }

  private relocate(): void {
    if (!this.listener) return;
    let found: Element | null;
    try {
      found = this.deps.parser.findRegion(this.deps.document);
    } catch (error) {
      this.logger.error('region.lookup-failed', { error });
      return;
    }
    if (found === this.region) return;

    const hadRegion = this.region !== null;
    this.detachRegion();

    if (!found) {
      this.lastSignature = null;
      this.logger.info('region.lost');
      this.emit({ kind: 'region-lost', at: this.deps.clock.now() });
      return;
    }

    // A swap from one region element to another is NOT a loss (no flush): the
    // tracker re-adopts re-rendered blocks. It is still announced as region-found
    // so listeners can re-apply anything attached to the element.
    this.logger.info(hadRegion ? 'region.replaced' : 'region.found');
    this.attachRegion(found);
    this.emit({ kind: 'region-found', at: this.deps.clock.now() });
  }

  private attachRegion(region: Element): void {
    this.region = region;
    this.regionObserver = new MutationObserver(() => this.snapshot());
    this.regionObserver.observe(region, { childList: true, subtree: true, characterData: true });
    this.snapshot();
  }

  private detachRegion(): void {
    this.regionObserver?.disconnect();
    this.regionObserver = null;
    this.region = null;
  }

  private snapshot(): void {
    const region = this.region;
    if (!region || !this.listener) return;
    if (!region.isConnected) {
      this.scheduleRelocate();
      return;
    }
    let blocks: CaptionBlockSnapshot[];
    try {
      blocks = this.deps.parser
        .parseBlocks(region)
        .map((b) => ({ key: this.keyFor(b.element), speaker: b.speaker, text: b.text }));
    } catch (error) {
      this.logger.error('parse.failed', { error });
      return;
    }
    const signature = blocks.map((b) => `${b.key}\u0000${b.speaker}\u0000${b.text}`).join('\u0001');
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.emit({ kind: 'snapshot', blocks, at: this.deps.clock.now() });
  }

  private keyFor(element: Element): string {
    let key = this.keys.get(element);
    if (!key) {
      key = `b${this.nextKey++}`;
      this.keys.set(element, key);
    }
    return key;
  }

  private emit(event: CaptionObserverEvent): void {
    try {
      this.listener?.(event);
    } catch (error) {
      this.logger.error('listener.failed', { error, kind: event.kind });
    }
  }
}
