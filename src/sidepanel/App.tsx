import { useEffect, useRef, useState } from 'react';
import type { TabState, TranscriptSegment } from '../shared/types';
import { CaptionLanguage } from './CaptionLanguage';
import { Diagnostics } from './Diagnostics';
import { formatClock, formatDuration } from './format';
import { useActiveTab } from './useActiveTab';
import { useSettings } from './useSettings';
import { useTabCapture } from './useTabCapture';

export function App() {
  const tabId = useActiveTab();
  const capture = useTabCapture(tabId);
  const { settings, update, error: settingsError } = useSettings();
  const capturing = capture.state?.capture != null;

  return (
    <div className="app">
      <header className="header">
        <h1>MeetNotes</h1>
        <span className={`pill ${capturing ? 'pill--live' : ''}`} role="status">
          <span className="pill__dot" aria-hidden="true" />
          {capturing ? 'Capturing' : 'Idle'}
        </span>
      </header>

      <StatusCard
        state={capture.state}
        busy={capture.busy}
        hideCaptions={settings.hideCaptionsOverlay}
        onStart={capture.start}
        onStop={capture.stop}
      />
      {(capture.error ?? settingsError) && (
        <p className="notice notice--error" role="alert">
          {capture.error ?? settingsError}
        </p>
      )}
      <label className="setting">
        <input
          type="checkbox"
          checked={settings.hideCaptionsOverlay}
          onChange={(e) => update({ hideCaptionsOverlay: e.currentTarget.checked })}
        />
        <span>
          Hide captions in Meet while capturing
          <span className="hint">Captions stay on so MeetNotes can read them; they're just not shown on screen.</span>
        </span>
      </label>
      <Transcript segments={capture.segments} />
      {capture.state?.contentReady && <Diagnostics tabId={capture.state.tabId} />}

      <footer className="footer">Everything stays in this browser. Phase 1 keeps the transcript in memory only.</footer>
    </div>
  );
}

interface StatusCardProps {
  readonly state: TabState | null;
  readonly busy: boolean;
  readonly hideCaptions: boolean;
  readonly onStart: () => void;
  readonly onStop: () => void;
}

function StatusCard({ state, busy, hideCaptions, onStart, onStop }: StatusCardProps) {
  if (!state) return <section className="card muted">Checking this tab…</section>;
  if (!state.contentReady || !state.page) {
    return (
      <section className="card">
        <p className="muted">Open a Google Meet meeting in this tab.</p>
        <p className="hint">If a Meet tab was already open before MeetNotes was installed or reloaded, refresh it once.</p>
      </section>
    );
  }
  const { page, capture } = state;
  if (!page.meetCode) {
    return <section className="card muted">This Meet page is not a meeting. Join or start one first.</section>;
  }

  return (
    <section className="card">
      <div className="meeting">
        <div>
          <div className="meeting__title">{page.title ?? page.meetCode}</div>
          <div className="meeting__meta">
            {page.meetCode} · {page.inCall ? 'In call' : 'Not in call'} · Captions{' '}
            {page.captionsVisible ? (capture && hideCaptions ? 'on (hidden)' : 'on') : 'off'}
          </div>
        </div>
        {capture && <Duration since={capture.startedAt} />}
      </div>

      {capture && !page.captionsVisible && (
        <p className="notice notice--warn">
          Captions are off, so nothing is being saved. MeetNotes tries to turn them on when you start — if that didn't
          work, press C in Meet.
        </p>
      )}
      {page.captionsVisible && <CaptionLanguage tabId={state.tabId} />}
      {!capture && !page.inCall && (
        <p className="hint">You can start now; captions are turned on once you join the call.</p>
      )}

      {capture ? (
        <button className="btn btn--stop" onClick={onStop} disabled={busy}>
          Stop capture
        </button>
      ) : (
        <button className="btn btn--start" onClick={onStart} disabled={busy}>
          Start capture
        </button>
      )}
    </section>
  );
}

function Duration({ since }: { readonly since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="duration" aria-label="Capture duration">
      {formatDuration(now - since)}
    </span>
  );
}

function Transcript({ segments }: { readonly segments: readonly TranscriptSegment[] }) {
  const listRef = useRef<HTMLOListElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const list = listRef.current;
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [segments]);

  if (segments.length === 0) {
    return <section className="transcript transcript--empty muted">Live transcript will appear here.</section>;
  }

  return (
    <ol
      className="transcript"
      ref={listRef}
      aria-live="polite"
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {segments.map((s) => (
        <li key={s.id} className={`segment ${s.status === 'interim' ? 'segment--interim' : ''}`}>
          <div className="segment__head">
            <span className="segment__speaker">{s.speaker}</span>
            <time className="segment__time" dateTime={new Date(s.startedAt).toISOString()}>
              {formatClock(s.startedAt)}
            </time>
          </div>
          <p className="segment__text">{s.text}</p>
        </li>
      ))}
    </ol>
  );
}
