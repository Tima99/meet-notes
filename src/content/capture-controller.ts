import type { Clock } from '../shared/clock';
import { createLogger, errorMessage, type Logger } from '../shared/logger';
import { fail, ok, type ContentCommand, type ContentStatusReport, type Result } from '../shared/messages';
import { DEFAULT_SETTINGS, type CaptureSettings } from '../shared/settings';
import type { CaptureEndReason, TranscriptSegment } from '../shared/types';
import { ExtensionContextInvalidatedError, type BackgroundBridge } from './background-bridge';
import type { CaptionObserver, CaptionObserverEvent } from './captions/caption-observer';
import type { CaptionTracker } from './captions/caption-tracker';
import type { CaptionLanguageControl } from './meet/caption-language';
import type { CaptionsToggle } from './meet/captions-toggle';
import type { MeetDetector } from './meet/meet-detector';
import { SegmentSink } from './segment-sink';
import type { CaptionHider } from './ui/caption-hider';
import type { IndicatorState } from './ui/capture-indicator';

export interface Indicator {
  show(state: IndicatorState): void;
  hide(): void;
}

export interface CaptureControllerDeps {
  readonly detector: MeetDetector;
  readonly bridge: BackgroundBridge;
  readonly indicator: Indicator;
  readonly captionsToggle: CaptionsToggle;
  readonly captionHider: CaptionHider;
  readonly captionLanguage: CaptionLanguageControl;
  /** Structural layout snapshot for troubleshooting (no caption text). */
  readonly diagnostics?: () => string;
  readonly clock: Clock;
  readonly createObserver: () => CaptionObserver;
  readonly createTracker: (meetingId: string) => CaptionTracker;
  readonly window: Pick<Window, 'addEventListener'>;
  readonly logger?: Logger;
  /** How often time-based finalization runs. */
  readonly tickIntervalMs?: number;
  /** Leave-call controls must be gone this long before the meeting counts as ended. */
  readonly meetingEndGraceMs?: number;
}

interface ActiveCapture {
  readonly meetingId: string;
  readonly startedAt: number;
  readonly meetCode: string | null;
  readonly observer: CaptionObserver;
  readonly tracker: CaptionTracker;
  readonly sink: SegmentSink;
  readonly tickTimer: ReturnType<typeof setInterval>;
  sawInCall: boolean;
  settings: CaptureSettings;
}

const FINAL_FLUSH_ATTEMPTS = 3;

/**
 * Orchestrates one capture session inside the Meet tab:
 *   MeetDetector ─┐
 *   CaptionObserver ─▶ CaptionTracker ─▶ SegmentSink ─▶ BackgroundBridge
 * Capture only ever starts from an explicit `content/start-capture` command.
 */
export class CaptureController {
  private capture: ActiveCapture | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private invalidated = false;
  private readonly logger: Logger;

  constructor(private readonly deps: CaptureControllerDeps) {
    this.logger = deps.logger ?? createLogger('controller');
  }

  init(): void {
    this.deps.bridge.onCommand((command) => this.handleCommand(command));
    this.deps.detector.start(() => this.onPageStatusChanged());
    this.deps.window.addEventListener('pagehide', () => void this.stop('page-unloaded'));
    void this.reportStatus();
    this.logger.info('ready', { meetCode: this.deps.detector.status.meetCode });
  }

  report(): ContentStatusReport {
    const c = this.capture;
    return {
      page: this.deps.detector.status,
      capture: c ? { meetingId: c.meetingId, startedAt: c.startedAt } : null,
    };
  }

  async handleCommand(command: ContentCommand): Promise<Result<unknown>> {
    switch (command.type) {
      case 'content/get-status':
        this.deps.detector.poll();
        return ok(this.report());
      case 'content/start-capture':
        try {
          this.start(command.meetingId, command.startedAt, command.settings);
          return ok(this.report());
        } catch (error) {
          return fail(errorMessage(error));
        }
      case 'content/apply-settings':
        this.applySettings(command.settings);
        return ok(this.report());
      case 'content/get-diagnostics':
        return this.deps.diagnostics ? ok(this.deps.diagnostics()) : fail('Diagnostics unavailable.');
      case 'content/get-caption-language':
        return this.deps.captionLanguage.get(command.withOptions).then(ok, (error: unknown) => fail(errorMessage(error)));
      case 'content/set-caption-language':
        return this.deps.captionLanguage
          .set(command.language)
          .then(ok, (error: unknown) => fail(errorMessage(error)))
          .finally(() => this.applyCaptionVisibility());
      case 'content/stop-capture':
        await this.stop(command.reason);
        return ok(this.report());
    }
  }

  start(meetingId: string, startedAt: number, settings: CaptureSettings = DEFAULT_SETTINGS): void {
    if (this.invalidated) throw new Error('Extension was reloaded — refresh the Meet tab.');
    if (this.capture?.meetingId === meetingId) return;
    if (this.capture) throw new Error('Already capturing a different meeting in this tab.');
    const page = this.deps.detector.poll();
    if (!page.meetCode) throw new Error('This tab is not a Google Meet meeting.');

    const tracker = this.deps.createTracker(meetingId);
    const sink = new SegmentSink((segments) => this.sendSegments(segments), {}, this.logger.child('sink'));
    tracker.subscribe(({ segment }) => sink.push(segment));
    const observer = this.deps.createObserver();
    const tickTimer = setInterval(() => tracker.tick(this.deps.clock.now()), this.deps.tickIntervalMs ?? 500);

    this.capture = {
      meetingId,
      startedAt,
      meetCode: page.meetCode,
      observer,
      tracker,
      sink,
      tickTimer,
      sawInCall: page.inCall,
      settings,
    };
    // Hide mode goes on before captions are turned on, so Meet never lays out a full panel.
    if (settings.hideCaptionsOverlay) this.deps.captionHider.prepare();
    observer.start((event) => this.onObserverEvent(event));
    this.updateIndicator();
    void this.reportStatus();
    void this.turnOnCaptions(meetingId);
    this.logger.info('capture.started', { meetingId, meetCode: page.meetCode, inCall: page.inCall });
  }

  /** Live settings change from the side panel. */
  applySettings(settings: CaptureSettings): void {
    const c = this.capture;
    if (!c) return;
    const changed = c.settings.hideCaptionsOverlay !== settings.hideCaptionsOverlay;
    c.settings = settings;
    this.applyCaptionVisibility();
    // Meet only re-lays out the captions panel when captions (re)start.
    if (changed && c.observer.hasRegion) void this.relayoutCaptions();
  }

  private relayout: Promise<void> | null = null;

  /** Restart captions once (never concurrently); stop() waits for it to finish. */
  private relayoutCaptions(): Promise<void> {
    this.relayout ??= (async () => {
      try {
        const ok = await this.deps.captionsToggle.restart();
        this.logger.info('captions.relayout', { ok });
      } catch (error) {
        this.logger.warn('captions.relayout-failed', { error });
      } finally {
        this.relayout = null;
        if (this.capture) {
          this.applyCaptionVisibility();
          this.updateIndicator();
        }
      }
    })();
    return this.relayout;
  }

  async stop(reason: CaptureEndReason): Promise<void> {
    const c = this.capture;
    if (!c) return;
    this.capture = null;
    this.clearEndTimer();
    clearInterval(c.tickTimer);
    c.observer.stop();

    // Let an in-flight captions restart finish, so it can't switch captions back on after stop.
    if (this.relayout) await this.relayout;

    const endedAt = this.deps.clock.now();
    c.tracker.flush(endedAt);
    await this.flushFinal(c.sink);
    this.deps.indicator.hide();
    this.deps.captionHider.show();
    await this.deps.captionsToggle.restore().catch((error: unknown) => this.logger.warn('captions.restore-failed', { error }));

    this.logger.info('capture.stopped', { meetingId: c.meetingId, reason, segments: c.tracker.segmentCount });
    if (this.invalidated) return;
    try {
      await this.deps.bridge.send({ type: 'content/capture-ended', meetingId: c.meetingId, reason, endedAt });
    } catch (error) {
      this.handleSendError(error, 'capture-ended');
    }
    void this.reportStatus();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private onObserverEvent(event: CaptionObserverEvent): void {
    const c = this.capture;
    if (!c) return;
    switch (event.kind) {
      case 'snapshot':
        c.tracker.ingest(event.blocks, event.at);
        return;
      case 'region-lost':
        // Captions turned off (or Meet tore the region down): close every open segment.
        c.tracker.flush(event.at);
        this.afterRegionChange();
        return;
      case 'region-found':
        this.afterRegionChange();
        return;
    }
  }

  private afterRegionChange(): void {
    this.applyCaptionVisibility();
    this.updateIndicator();
    this.deps.detector.poll(); // refresh captionsVisible promptly
  }

  private onPageStatusChanged(): void {
    void this.reportStatus();
    const c = this.capture;
    if (!c) return;
    const page = this.deps.detector.status;

    if (page.meetCode !== c.meetCode) {
      void this.stop('meeting-ended');
      return;
    }
    if (page.inCall) {
      // Started from the lobby: the captions button only exists once in the call.
      if (!c.sawInCall) void this.turnOnCaptions(c.meetingId);
      c.sawInCall = true;
      this.clearEndTimer();
    } else if (c.sawInCall && this.endTimer === null) {
      // Only auto-stop if we have seen the call controls during this capture,
      // so a broken in-call selector can never stop a capture on its own.
      this.endTimer = setTimeout(() => {
        this.endTimer = null;
        if (!this.deps.detector.poll().inCall) void this.stop('meeting-ended');
      }, this.deps.meetingEndGraceMs ?? 3000);
    }
    this.updateIndicator();
  }

  /**
   * Captions must be ON for Meet to put caption text in the DOM. Capture was
   * explicitly started by the user, so turn them on for them (once). If the user
   * turns them off later, we respect that and show the waiting indicator.
   */
  private async turnOnCaptions(meetingId: string): Promise<void> {
    try {
      const result = await this.deps.captionsToggle.ensureOn();
      this.logger.info('captions.ensure-on', { result });
      // Captions were already on, so Meet laid out a full-size panel before our
      // styles applied. Restart them so Meet lays out the collapsed panel instead.
      if (result === 'already-on' && this.capture?.meetingId === meetingId && this.capture.settings.hideCaptionsOverlay) {
        await this.relayoutCaptions();
      }
    } catch (error) {
      this.logger.warn('captions.ensure-on-failed', { error });
    }
    if (this.capture?.meetingId === meetingId) {
      this.deps.detector.poll();
      this.updateIndicator();
    }
  }

  private applyCaptionVisibility(): void {
    const c = this.capture;
    const region = c?.observer.regionElement ?? null;
    if (c?.settings.hideCaptionsOverlay) {
      if (region) this.deps.captionHider.hide(region);
      else this.deps.captionHider.prepare();
    } else {
      this.deps.captionHider.show();
    }
  }

  private updateIndicator(): void {
    const c = this.capture;
    if (!c) {
      this.deps.indicator.hide();
      return;
    }
    this.deps.indicator.show(c.observer.hasRegion ? 'capturing' : 'waiting-for-captions');
  }

  private async sendSegments(segments: readonly TranscriptSegment[]): Promise<void> {
    if (this.invalidated) return;
    try {
      await this.deps.bridge.send({ type: 'content/segments', segments });
    } catch (error) {
      if (error instanceof ExtensionContextInvalidatedError) {
        this.onInvalidated();
        return; // nowhere left to deliver to
      }
      throw error; // sink will retry
    }
  }

  private async flushFinal(sink: SegmentSink): Promise<void> {
    for (let attempt = 1; attempt <= FINAL_FLUSH_ATTEMPTS && sink.pendingCount > 0; attempt++) {
      try {
        await sink.flush();
      } catch (error) {
        this.logger.warn('final-flush.retry', { attempt, error });
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
    if (sink.pendingCount > 0) this.logger.error('final-flush.failed', { lost: sink.pendingCount });
    sink.dispose();
  }

  private async reportStatus(): Promise<void> {
    if (this.invalidated) return;
    try {
      await this.deps.bridge.send({ type: 'content/status', report: this.report() });
    } catch (error) {
      this.handleSendError(error, 'status');
    }
  }

  private handleSendError(error: unknown, what: string): void {
    if (error instanceof ExtensionContextInvalidatedError) this.onInvalidated();
    else this.logger.debug('send.failed', { what, error });
  }

  /** The extension was reloaded: this script can no longer talk to it. Shut down quietly. */
  private onInvalidated(): void {
    if (this.invalidated) return;
    this.invalidated = true;
    this.logger.warn('extension-context.invalidated');
    this.deps.detector.stop();
    void this.stop('extension-invalidated');
  }

  private clearEndTimer(): void {
    if (this.endTimer !== null) clearTimeout(this.endTimer);
    this.endTimer = null;
  }
}
