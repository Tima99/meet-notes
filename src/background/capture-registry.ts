import { createLogger, type Logger } from '../shared/logger';
import type { CaptureSession, MeetPageStatus, TabState } from '../shared/types';

/** chrome.storage.session subset we depend on (injectable for tests). */
export interface SessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

interface PersistedRegistry {
  readonly captures: Record<string, CaptureSession>;
  readonly lastMeetingByTab: Record<string, string>;
}

const STORAGE_KEY = 'meetnotes.registry.v1';

interface TabRuntime {
  page: MeetPageStatus | null;
  contentReady: boolean;
}

/**
 * Which tab is capturing which meeting. Active captures are mirrored to
 * chrome.storage.session so they survive service-worker restarts (the SW is
 * routinely suspended during long meetings). Session storage is in-memory,
 * never synced, and not readable by content scripts.
 */
export class CaptureRegistry {
  private captures = new Map<number, CaptureSession>();
  private lastMeetingByTab = new Map<number, string>();
  private readonly tabs = new Map<number, TabRuntime>();
  private readonly ready: Promise<void>;

  constructor(
    private readonly storage: SessionStorageArea,
    private readonly logger: Logger = createLogger('registry'),
  ) {
    this.ready = this.load();
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  getState(tabId: number): TabState {
    const runtime = this.tabs.get(tabId);
    return {
      tabId,
      contentReady: runtime?.contentReady ?? false,
      page: runtime?.page ?? null,
      capture: this.captures.get(tabId) ?? null,
    };
  }

  getCapture(tabId: number): CaptureSession | null {
    return this.captures.get(tabId) ?? null;
  }

  /** Meeting to show in the panel for a tab: the active one, else the last one. */
  getDisplayMeetingId(tabId: number): string | null {
    return this.captures.get(tabId)?.meetingId ?? this.lastMeetingByTab.get(tabId) ?? null;
  }

  activeTabIds(): number[] {
    return [...this.captures.keys()];
  }

  findTabByMeeting(meetingId: string): number | null {
    for (const [tabId, session] of this.captures) if (session.meetingId === meetingId) return tabId;
    return null;
  }

  setPage(tabId: number, page: MeetPageStatus | null, contentReady: boolean): void {
    this.tabs.set(tabId, { page, contentReady });
  }

  async startSession(session: CaptureSession): Promise<void> {
    this.captures.set(session.tabId, session);
    this.lastMeetingByTab.set(session.tabId, session.meetingId);
    await this.persist();
  }

  /** Ends the tab's session (optionally only if it matches `meetingId`). Idempotent. */
  async endSession(tabId: number, meetingId?: string): Promise<CaptureSession | null> {
    const session = this.captures.get(tabId);
    if (!session || (meetingId !== undefined && session.meetingId !== meetingId)) return null;
    this.captures.delete(tabId);
    await this.persist();
    return session;
  }

  async forgetTab(tabId: number): Promise<void> {
    this.tabs.delete(tabId);
    this.captures.delete(tabId);
    this.lastMeetingByTab.delete(tabId);
    await this.persist();
  }

  private async load(): Promise<void> {
    try {
      const stored = (await this.storage.get(STORAGE_KEY))[STORAGE_KEY];
      if (!isPersistedRegistry(stored)) return;
      this.captures = new Map(Object.entries(stored.captures).map(([k, v]) => [Number(k), v]));
      this.lastMeetingByTab = new Map(Object.entries(stored.lastMeetingByTab).map(([k, v]) => [Number(k), v]));
      this.logger.info('restored', { activeCaptures: this.captures.size });
    } catch (error) {
      this.logger.error('restore.failed', { error });
    }
  }

  private async persist(): Promise<void> {
    const value: PersistedRegistry = {
      captures: Object.fromEntries([...this.captures].map(([k, v]) => [String(k), v])),
      lastMeetingByTab: Object.fromEntries([...this.lastMeetingByTab].map(([k, v]) => [String(k), v])),
    };
    try {
      await this.storage.set({ [STORAGE_KEY]: value });
    } catch (error) {
      this.logger.error('persist.failed', { error });
    }
  }
}

function isPersistedRegistry(value: unknown): value is PersistedRegistry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Record<keyof PersistedRegistry, unknown>>;
  return typeof v.captures === 'object' && v.captures !== null && typeof v.lastMeetingByTab === 'object' && v.lastMeetingByTab !== null;
}
