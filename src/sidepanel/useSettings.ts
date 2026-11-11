import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../shared/logger';
import { DEFAULT_SETTINGS, type CaptureSettings } from '../shared/settings';
import { request } from './api';

export function useSettings(): {
  readonly settings: CaptureSettings;
  readonly error: string | null;
  update(patch: Partial<CaptureSettings>): void;
} {
  const [settings, setSettings] = useState<CaptureSettings>(DEFAULT_SETTINGS);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    request({ type: 'panel/get-settings' })
      .then(setSettings)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);

  const update = useCallback((patch: Partial<CaptureSettings>) => {
    setSettings((current) => ({ ...current, ...patch })); // optimistic
    request({ type: 'panel/update-settings', patch })
      .then((saved) => {
        setSettings(saved);
        setError(null);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);

  return { settings, error, update };
}
