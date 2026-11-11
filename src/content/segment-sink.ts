import { createLogger, type Logger } from '../shared/logger';
import type { TranscriptSegment } from '../shared/types';

export type SegmentSender = (segments: readonly TranscriptSegment[]) => Promise<void>;

export interface SegmentSinkOptions {
  /** Interim updates are coalesced per segment for this long. */
  readonly interimDelayMs: number;
  /** Delay before re-sending after a failed send. */
  readonly retryDelayMs: number;
}

const DEFAULT_SINK_OPTIONS: SegmentSinkOptions = { interimDelayMs: 300, retryDelayMs: 2000 };

/**
 * Batches segment upserts on their way to the service worker.
 *  - Final segments are sent immediately.
 *  - Interim updates are coalesced (only the latest version per id is sent).
 *  - Failed sends are retried; a newer version of the same segment always wins.
 */
export class SegmentSink {
  private readonly pending = new Map<string, TranscriptSegment>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly options: SegmentSinkOptions;

  constructor(
    private readonly send: SegmentSender,
    options: Partial<SegmentSinkOptions> = {},
    private readonly logger: Logger = createLogger('sink'),
  ) {
    this.options = { ...DEFAULT_SINK_OPTIONS, ...options };
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  push(segment: TranscriptSegment): void {
    this.pending.set(segment.id, segment);
    if (segment.status === 'final') this.schedule(0);
    else this.schedule(this.options.interimDelayMs);
  }

  /** Sends everything pending now. Resolves once the send attempt settles. */
  async flush(): Promise<void> {
    this.clearTimer();
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    if (this.pending.size === 0) return;

    const batch = [...this.pending.values()].sort((a, b) => a.sequence - b.sequence);
    this.pending.clear();
    this.inFlight = this.send(batch)
      .catch((error: unknown) => {
        for (const segment of batch) {
          if (!this.pending.has(segment.id)) this.pending.set(segment.id, segment);
        }
        this.logger.warn('send.failed', { error, segments: batch.length });
        this.schedule(this.options.retryDelayMs);
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
      });
    await this.inFlight;
  }

  dispose(): void {
    this.clearTimer();
    this.pending.clear();
  }

  private schedule(delay: number): void {
    if (this.timer !== null) {
      if (delay > 0) return; // an earlier flush is already scheduled
      this.clearTimer();
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => undefined); // failure already logged + retried
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
