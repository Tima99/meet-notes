import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../shared/logger';
import type { CaptionLanguageInfo } from '../shared/types';
import { request } from './api';

/**
 * Caption language picker. Meet's own picker sits in the captions panel that
 * MeetNotes hides, so it is operated from here instead.
 */
export function CaptionLanguage({ tabId }: { readonly tabId: number }) {
  const [current, setCurrent] = useState<string | null>(null);
  const [options, setOptions] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback((work: Promise<CaptionLanguageInfo>, keepOptions: boolean) => {
    setBusy(true);
    work
      .then((info) => {
        setCurrent(info.current);
        setOptions(keepOptions ? info.options : []);
        setError(null);
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  }, []);

  // Read the current language quietly (Meet's menu is not opened). Meet draws its
  // language bar a moment after the captions, so retry instead of showing an error.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = (left: number): void => {
      request({ type: 'panel/get-caption-language', tabId, withOptions: false })
        .then((info) => {
          if (!cancelled) setCurrent(info.current);
        })
        .catch(() => {
          if (!cancelled && left > 0) timer = setTimeout(() => attempt(left - 1), 1500);
        });
    };
    attempt(10);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [tabId]);

  return (
    <div className="language">
      <label className="language__row">
        <span className="language__label">Caption language</span>
        {options.length > 0 ? (
          <select
            value={current ?? ''}
            disabled={busy}
            autoFocus
            onChange={(e) =>
              run(request({ type: 'panel/set-caption-language', tabId, language: e.currentTarget.value }), false)
            }
          >
            {current && !options.includes(current) && <option value={current}>{current}</option>}
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <span className="language__current">
            {current ?? '—'}
            <button
              className="link"
              disabled={busy}
              onClick={() => run(request({ type: 'panel/get-caption-language', tabId, withOptions: true }), true)}
            >
              {busy ? 'Loading…' : 'Change'}
            </button>
          </span>
        )}
      </label>
      {error && <p className="hint hint--error">{error}</p>}
    </div>
  );
}
