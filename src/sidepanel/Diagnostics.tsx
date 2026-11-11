import { useState } from 'react';
import { errorMessage } from '../shared/logger';
import { request } from './api';

/** Collects a structural snapshot of Meet's layout (no caption text) for bug reports. */
export function Diagnostics({ tabId }: { readonly tabId: number }) {
  const [report, setReport] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const collect = (): void => {
    setStatus('Collecting…');
    request({ type: 'panel/get-diagnostics', tabId })
      .then((text) => {
        setReport(text);
        setStatus(null);
      })
      .catch((e: unknown) => setStatus(errorMessage(e)));
  };

  const copy = (): void => {
    if (!report) return;
    navigator.clipboard
      .writeText(report)
      .then(() => setStatus('Copied — paste it to your developer.'))
      .catch(() => setStatus('Copy failed — select the text and press Ctrl+C.'));
  };

  return (
    <details className="diagnostics">
      <summary>Troubleshooting</summary>
      <p className="hint">
        Collects how Meet's page is laid out around the captions. Contains no caption text and no names.
      </p>
      <div className="diagnostics__actions">
        <button className="link" onClick={collect}>
          Collect layout info
        </button>
        {report && (
          <button className="link" onClick={copy}>
            Copy
          </button>
        )}
      </div>
      {status && <p className="hint">{status}</p>}
      {report && <textarea className="diagnostics__report" readOnly value={report} rows={8} onFocus={(e) => e.currentTarget.select()} />}
    </details>
  );
}
