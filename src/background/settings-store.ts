import { DEFAULT_SETTINGS, parseSettings, type CaptureSettings } from '../shared/settings';
import type { SessionStorageArea } from './capture-registry';

const STORAGE_KEY = 'meetnotes.settings.v1';

/** Preferences in chrome.storage.local (device-only, never synced). */
export class SettingsStore {
  constructor(private readonly area: SessionStorageArea) {}

  async get(): Promise<CaptureSettings> {
    try {
      return parseSettings((await this.area.get(STORAGE_KEY))[STORAGE_KEY]);
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  async update(patch: Partial<CaptureSettings>): Promise<CaptureSettings> {
    const next = parseSettings({ ...(await this.get()), ...patch });
    await this.area.set({ [STORAGE_KEY]: next });
    return next;
  }
}
