import { createLogger, errorMessage, type Logger } from '../shared/logger';
import {
  isResult,
  type ContentCommand,
  type ContentEvent,
  type ContentStatusReport,
  type PanelStateSnapshot,
} from '../shared/messages';
import type { CaptureSettings } from '../shared/settings';
import type { CaptionLanguageInfo, CaptureEndReason } from '../shared/types';
import { setCaptureBadge } from './badge';
import type { CaptureRegistry } from './capture-registry';
import type { PanelHub } from './panel-hub';
import type { SegmentStore } from './segment-store';
import type { SettingsStore } from './settings-store';

/** A content status saying "not capturing" only ends a session older than this (start race). */
const START_RACE_GRACE_MS = 3000;
const CONTENT_PING_TIMEOUT_MS = 1500;

export interface TabMessenger {
  send(tabId: number, command: ContentCommand): Promise<unknown>;
}

export const chromeTabMessenger: TabMessenger = {
  send: (tabId, command) => chrome.tabs.sendMessage(tabId, command),
};

/** Service-worker side of capture: start/stop, content events, panel snapshots. */
export class CaptureService {
  /** Starts in flight, so a status report racing the start isn't mistaken for an unknown capture. */
  private readonly pendingStarts = new Map<number, string>();

  constructor(
    private readonly registry: CaptureRegistry,
    private readonly store: SegmentStore,
    private readonly hub: PanelHub,
    private readonly settings: SettingsStore,
    private readonly tabs: TabMessenger = chromeTabMessenger,
    private readonly now: () => number = Date.now,
    private readonly logger: Logger = createLogger('capture-service'),
  ) {}

  // ── panel requests ───────────────────────────────────────────────────────

  async getSnapshot(tabId: number, refresh = true): Promise<PanelStateSnapshot> {
    await this.registry.whenReady();
    if (refresh) await this.refreshTab(tabId);
    const meetingId = this.registry.getDisplayMeetingId(tabId);
    return {
      state: this.registry.getState(tabId),
      segments: meetingId ? await this.store.listByMeeting(meetingId) : [],
    };
  }

  async start(tabId: number): Promise<PanelStateSnapshot> {
    await this.registry.whenReady();
    if (this.registry.getCapture(tabId)) return this.getSnapshot(tabId, false);

    if (this.pendingStarts.has(tabId)) throw new Error('Capture is already starting.');

    const meetingId = crypto.randomUUID();
    const startedAt = this.now();
    const settings = await this.settings.get();
    this.pendingStarts.set(tabId, meetingId);
    try {
      const report = await this.command(tabId, { type: 'content/start-capture', meetingId, startedAt, settings });
      this.registry.setPage(tabId, report.page, true);
      await this.registry.startSession({
        meetingId,
        tabId,
        meetCode: report.page.meetCode,
        title: report.page.title,
        startedAt,
      });
    } finally {
      this.pendingStarts.delete(tabId);
    }
    await setCaptureBadge(tabId, true);
    this.logger.info('capture.started', { tabId, meetingId });
    this.pushState(tabId);
    return this.getSnapshot(tabId, false);
  }

  async stop(tabId: number): Promise<PanelStateSnapshot> {
    await this.registry.whenReady();
    try {
      await this.command(tabId, { type: 'content/stop-capture', reason: 'user-stopped' });
    } catch (error) {
      // Content gone (tab reloaded, extension updated): end our side regardless.
      this.logger.warn('stop.content-unreachable', { tabId, error });
    }
    await this.endSession(tabId, 'user-stopped');
    return this.getSnapshot(tabId, false);
  }

  async getCaptionLanguage(tabId: number, withOptions: boolean): Promise<CaptionLanguageInfo> {
    return this.command<CaptionLanguageInfo>(tabId, { type: 'content/get-caption-language', withOptions });
  }

  async setCaptionLanguage(tabId: number, language: string): Promise<CaptionLanguageInfo> {
    return this.command<CaptionLanguageInfo>(tabId, { type: 'content/set-caption-language', language });
  }

  async getDiagnostics(tabId: number): Promise<string> {
    return this.command<string>(tabId, { type: 'content/get-diagnostics' });
  }

  async getSettings(): Promise<CaptureSettings> {
    return this.settings.get();
  }

  /** Saves settings and pushes them to every tab that is currently capturing. */
  async updateSettings(patch: Partial<CaptureSettings>): Promise<CaptureSettings> {
    await this.registry.whenReady();
    const settings = await this.settings.update(patch);
    await Promise.all(
      this.registry.activeTabIds().map((tabId) =>
        this.command(tabId, { type: 'content/apply-settings', settings }).catch((error: unknown) =>
          this.logger.warn('settings.apply-failed', { tabId, error }),
        ),
      ),
    );
    return settings;
  }

  // ── content events ───────────────────────────────────────────────────────

  async handleContentEvent(tabId: number, event: ContentEvent): Promise<void> {
    await this.registry.whenReady();
    switch (event.type) {
      case 'content/status':
        await this.reconcile(tabId, event.report);
        return;
      case 'content/segments':
        await this.store.upsert(event.segments);
        this.hub.broadcast({ type: 'bg/segments', tabId, segments: event.segments });
        return;
      case 'content/capture-ended':
        await this.endSession(tabId, event.reason, event.meetingId);
        return;
    }
  }

  // ── tab lifecycle ────────────────────────────────────────────────────────

  async onTabRemoved(tabId: number): Promise<void> {
    await this.registry.whenReady();
    await this.endSession(tabId, 'page-unloaded');
    await this.registry.forgetTab(tabId);
  }

  /** Tab navigated/reloaded: the content script may be gone; check after it settles. */
  async onTabLoading(tabId: number): Promise<void> {
    await this.registry.whenReady();
    if (!this.registry.getCapture(tabId)) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await this.refreshTab(tabId);
    const capture = this.registry.getCapture(tabId);
    if (capture && !this.registry.getState(tabId).contentReady) await this.endSession(tabId, 'page-unloaded');
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async reconcile(tabId: number, report: ContentStatusReport): Promise<void> {
    this.registry.setPage(tabId, report.page, true);
    const session = this.registry.getCapture(tabId);
    const content = report.capture;

    if (content && this.pendingStarts.get(tabId) === content.meetingId) {
      // Our own start() is about to register this session.
    } else if (content && (!session || session.meetingId !== content.meetingId)) {
      // Content is capturing something we don't know about (SW state lost): adopt it.
      if (session) await this.endSession(tabId, 'error');
      await this.registry.startSession({
        meetingId: content.meetingId,
        tabId,
        meetCode: report.page.meetCode,
        title: report.page.title,
        startedAt: content.startedAt,
      });
      await setCaptureBadge(tabId, true);
      this.logger.warn('capture.adopted', { tabId, meetingId: content.meetingId });
    } else if (!content && session && this.now() - session.startedAt > START_RACE_GRACE_MS) {
      // Fresh content script (page reloaded) that isn't capturing.
      await this.endSession(tabId, 'page-unloaded');
      return; // endSession pushes state
    }
    this.pushState(tabId);
  }

  private async endSession(tabId: number, reason: CaptureEndReason, meetingId?: string): Promise<void> {
    const ended = await this.registry.endSession(tabId, meetingId);
    if (!ended) return;
    await setCaptureBadge(tabId, false);
    this.logger.info('capture.ended', { tabId, meetingId: ended.meetingId, reason });
    this.pushState(tabId);
  }

  private async refreshTab(tabId: number): Promise<void> {
    try {
      const report = await withTimeout(this.command(tabId, { type: 'content/get-status' }), CONTENT_PING_TIMEOUT_MS);
      await this.reconcile(tabId, report);
    } catch {
      this.registry.setPage(tabId, null, false);
    }
  }

  /** Sends a command to the tab's content script and unwraps its Result. */
  private async command<T = ContentStatusReport>(tabId: number, command: ContentCommand): Promise<T> {
    let response: unknown;
    try {
      response = await this.tabs.send(tabId, command);
    } catch (error) {
      throw new Error(`MeetNotes is not active in this tab — reload the Meet tab. (${errorMessage(error)})`);
    }
    if (!isResult(response)) throw new Error('Unexpected response from the Meet tab.');
    if (!response.ok) throw new Error(response.error);
    return response.data as T;
  }

  private pushState(tabId: number): void {
    this.hub.broadcast({ type: 'bg/tab-state', state: this.registry.getState(tabId) });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(errorMessage(error)));
      },
    );
  });
}
