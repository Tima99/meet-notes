/** User preferences, stored in chrome.storage.local (never synced). */
export interface CaptureSettings {
  /** Keep Meet's captions on (required for capture) but hide them from view. */
  readonly hideCaptionsOverlay: boolean;
}

export const DEFAULT_SETTINGS: CaptureSettings = { hideCaptionsOverlay: true };

export function parseSettings(value: unknown): CaptureSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_SETTINGS;
  const v = value as Partial<Record<keyof CaptureSettings, unknown>>;
  return {
    hideCaptionsOverlay: typeof v.hideCaptionsOverlay === 'boolean' ? v.hideCaptionsOverlay : DEFAULT_SETTINGS.hideCaptionsOverlay,
  };
}
