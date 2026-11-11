import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MeetingRecord } from '../../src/shared/db/schema';
import {
  exportFileName,
  meetingDuration,
  meetingTitle,
  toArchiveJson,
  toJson,
  toTxt,
} from '../../src/shared/export/transcript-export';
import { formatDateTime, formatDuration, formatOffset } from '../../src/shared/format';
import type { MeetingDetail } from '../../src/shared/web-protocol';
import { downloadText } from './download';
import { MeetNotesClient, type ExtensionInfo } from './extension-client';

type Connection =
  | { readonly status: 'checking' }
  | { readonly status: 'connected'; readonly info: ExtensionInfo }
  | { readonly status: 'not-found' };

const LIVE_REFRESH_MS = 5000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/** Stable colour slot (0–7) per speaker name. */
function speakerSlot(name: string): number {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return hash % 8;
}

export function App() {
  const client = useMemo(() => new MeetNotesClient(), []);
  const [connection, setConnection] = useState<Connection>({ status: 'checking' });
  const [meetings, setMeetings] = useState<readonly MeetingRecord[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(() => {
    setConnection({ status: 'checking' });
    void client.connect().then((info) => setConnection(info ? { status: 'connected', info } : { status: 'not-found' }));
  }, [client]);

  useEffect(() => {
    connect();
    return () => client.dispose();
  }, [client, connect]);

  const loadMeetings = useCallback(() => {
    client
      .request({ type: 'list-meetings' })
      .then((list) => {
        setMeetings(list);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, [client]);

  useEffect(() => {
    if (connection.status === 'connected') loadMeetings();
  }, [connection.status, loadMeetings]);

  // Keep the list fresh while a meeting is being captured.
  const anyActive = meetings?.some((m) => m.status === 'active') ?? false;
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(loadMeetings, LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [anyActive, loadMeetings]);

  if (connection.status !== 'connected') {
    return (
      <Shell connection={connection}>
        {connection.status === 'checking' ? (
          <div className="center muted">Looking for the MeetNotes extension in this browser…</div>
        ) : (
          <NotDetected onRetry={connect} />
        )}
      </Shell>
    );
  }

  return (
    <Shell
      connection={connection}
      actions={
        <>
          <button className="btn btn--ghost" onClick={loadMeetings}>
            Refresh
          </button>
          <ExportAllButton client={client} meetings={meetings ?? []} />
        </>
      }
    >
      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      {meetings === null ? (
        <div className="center muted">Loading meetings…</div>
      ) : meetings.length === 0 ? (
        <div className="center">
          <div className="empty">
            <h2>No meetings saved yet</h2>
            <p className="muted">
              Join a Google Meet call, open the MeetNotes side panel and press <strong>Start capture</strong>. Meetings
              appear here automatically.
            </p>
          </div>
        </div>
      ) : (
        <div className={`layout ${selectedId ? 'layout--detail' : ''}`}>
          <MeetingList meetings={meetings} selectedId={selectedId} onSelect={setSelectedId} />
          {selectedId ? (
            <MeetingView key={selectedId} client={client} meetingId={selectedId} onBack={() => setSelectedId(null)} />
          ) : (
            <section className="detail detail--placeholder muted">Select a meeting to preview and export it.</section>
          )}
        </div>
      )}
    </Shell>
  );
}

// ── layout ───────────────────────────────────────────────────────────────────

function Shell({
  connection,
  actions,
  children,
}: {
  readonly connection: Connection;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__logo" aria-hidden="true" />
          <span className="brand__name">MeetNotes</span>
        </div>
        <ConnectionBadge connection={connection} />
        <div className="topbar__actions">{actions}</div>
      </header>
      <main className="main">{children}</main>
      <footer className="footer">
        Your transcripts are read from the MeetNotes extension inside this browser. They are never uploaded.
      </footer>
    </div>
  );
}

function ConnectionBadge({ connection }: { readonly connection: Connection }) {
  const label =
    connection.status === 'connected'
      ? `Extension connected · v${connection.info.extensionVersion}`
      : connection.status === 'checking'
        ? 'Connecting…'
        : 'Extension not detected';
  return (
    <span className={`badge badge--${connection.status}`} role="status">
      <span className="badge__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function NotDetected({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <div className="center">
      <div className="empty">
        <h2>MeetNotes extension not detected</h2>
        <p className="muted">This page reads your saved meetings straight from the extension, so it needs:</p>
        <ol className="steps">
          <li>Google Chrome with the MeetNotes extension installed and enabled.</li>
          <li>
            This site's address added to the extension when it was built:
            <code className="code">MEETNOTES_WEB_ORIGINS={window.location.origin}</code>
            in the extension's <code>.env</code>, then <code>npm run build</code> and reload the extension.
          </li>
          <li>After reloading the extension, refresh this page.</li>
        </ol>
        <button className="btn btn--primary" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

// ── meeting list ─────────────────────────────────────────────────────────────

function statusLabel(m: MeetingRecord): { readonly text: string; readonly tone: string } {
  if (m.status === 'active') return { text: 'Live', tone: 'live' };
  if (m.endReason === 'interrupted') return { text: 'Interrupted', tone: 'warn' };
  return { text: 'Ended', tone: 'neutral' };
}

function MeetingList({
  meetings,
  selectedId,
  onSelect,
}: {
  readonly meetings: readonly MeetingRecord[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return meetings;
    return meetings.filter((m) =>
      [meetingTitle(m), m.meetCode ?? '', ...m.speakers].some((field) => field.toLowerCase().includes(q)),
    );
  }, [meetings, query]);

  const totalSegments = meetings.reduce((sum, m) => sum + m.segmentCount, 0);

  return (
    <aside className="sidebar" aria-label="Meetings">
      <div className="sidebar__head">
        <input
          className="input"
          type="search"
          placeholder="Search meetings, codes, people…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          aria-label="Search meetings"
        />
        <p className="sidebar__stats muted">
          {meetings.length} meeting{meetings.length === 1 ? '' : 's'} · {totalSegments.toLocaleString()} lines
        </p>
      </div>
      <ul className="meeting-list">
        {filtered.map((m) => {
          const status = statusLabel(m);
          return (
            <li key={m.id}>
              <button
                className={`meeting ${m.id === selectedId ? 'meeting--selected' : ''}`}
                onClick={() => onSelect(m.id)}
                aria-current={m.id === selectedId ? 'true' : undefined}
              >
                <span className="meeting__row">
                  <span className="meeting__title">{meetingTitle(m)}</span>
                  <span className={`tag tag--${status.tone}`}>{status.text}</span>
                </span>
                <span className="meeting__meta">
                  {formatDateTime(m.startedAt)} · {formatDuration(meetingDuration(m))} · {m.segmentCount} lines
                </span>
                {m.speakers.length > 0 && <span className="meeting__people">{m.speakers.join(', ')}</span>}
              </button>
            </li>
          );
        })}
        {filtered.length === 0 && <li className="muted meeting-list__empty">No meetings match “{query}”.</li>}
      </ul>
    </aside>
  );
}

// ── meeting detail ───────────────────────────────────────────────────────────

function MeetingView({
  client,
  meetingId,
  onBack,
}: {
  readonly client: MeetNotesClient;
  readonly meetingId: string;
  readonly onBack: () => void;
}) {
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState(false);
  const live = detail?.meeting.status === 'active';

  const load = useCallback(() => {
    client
      .request({ type: 'get-meeting', meetingId })
      .then((d) => {
        setDetail(d);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, [client, meetingId]);

  useEffect(load, [load]);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(load, LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, load]);

  const lines = useMemo(() => {
    if (!detail) return [];
    const q = filter.trim().toLowerCase();
    return q
      ? detail.segments.filter((s) => s.text.toLowerCase().includes(q) || s.speaker.toLowerCase().includes(q))
      : detail.segments;
  }, [detail, filter]);

  const topRef = useRef<HTMLDivElement>(null);
  useEffect(() => topRef.current?.scrollIntoView({ block: 'start' }), [meetingId]);

  if (error) {
    return (
      <section className="detail">
        <BackButton onBack={onBack} />
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      </section>
    );
  }
  if (!detail) return <section className="detail detail--placeholder muted">Loading transcript…</section>;

  const { meeting, segments } = detail;
  const exportTxt = (): void => downloadText(exportFileName(meeting, 'txt'), toTxt(meeting, segments), 'text/plain');
  const exportJson = (): void =>
    downloadText(exportFileName(meeting, 'json'), toJson(meeting, segments, Date.now()), 'application/json');
  const copy = (): void => {
    void navigator.clipboard.writeText(toTxt(meeting, segments)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <section className="detail" aria-label="Transcript">
      <div ref={topRef} />
      <BackButton onBack={onBack} />
      <div className="detail__head">
        <div>
          <h1 className="detail__title">{meetingTitle(meeting)}</h1>
          <p className="detail__meta muted">
            {formatDateTime(meeting.startedAt)} · {formatDuration(meetingDuration(meeting, segments))}
            {meeting.meetCode && <> · {meeting.meetCode}</>}
            {live && <span className="tag tag--live">Live</span>}
          </p>
          {meeting.speakers.length > 0 && (
            <ul className="speakers" aria-label="Participants">
              {meeting.speakers.map((s) => (
                <li key={s} className={`chip spk-${speakerSlot(s)}`}>
                  {s}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="detail__actions">
          <button className="btn btn--primary" onClick={exportTxt} disabled={segments.length === 0}>
            Export TXT
          </button>
          <button className="btn" onClick={exportJson} disabled={segments.length === 0}>
            Export JSON
          </button>
          <button className="btn btn--ghost" onClick={copy} disabled={segments.length === 0}>
            {copied ? 'Copied' : 'Copy text'}
          </button>
        </div>
      </div>

      <input
        className="input detail__filter"
        type="search"
        placeholder="Find in transcript…"
        value={filter}
        onChange={(e) => setFilter(e.currentTarget.value)}
        aria-label="Find in transcript"
      />

      {segments.length === 0 ? (
        <p className="muted">No captions were saved for this meeting.</p>
      ) : (
        <ol className="transcript">
          {lines.map((s) => (
            <li key={s.id} className={`line ${s.status === 'interim' ? 'line--interim' : ''}`}>
              <time className="line__time" dateTime={new Date(s.startedAt).toISOString()}>
                {formatOffset(s.startedAt - meeting.startedAt)}
              </time>
              <span className={`line__speaker spk-${speakerSlot(s.speaker)}`}>{s.speaker}</span>
              <p className="line__text">{s.text}</p>
            </li>
          ))}
          {lines.length === 0 && <li className="muted">Nothing matches “{filter}”.</li>}
        </ol>
      )}
    </section>
  );
}

function BackButton({ onBack }: { readonly onBack: () => void }) {
  return (
    <button className="btn btn--ghost back" onClick={onBack}>
      ← All meetings
    </button>
  );
}

function ExportAllButton({ client, meetings }: { readonly client: MeetNotesClient; readonly meetings: readonly MeetingRecord[] }) {
  const [busy, setBusy] = useState(false);
  const exportAll = (): void => {
    setBusy(true);
    (async () => {
      const details: MeetingDetail[] = [];
      for (const m of meetings) details.push(await client.request({ type: 'get-meeting', meetingId: m.id }));
      const day = new Date().toISOString().slice(0, 10);
      downloadText(`meetnotes-all-${day}.json`, toArchiveJson(details, Date.now()), 'application/json');
    })()
      .catch((e: unknown) => alert(errorText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <button className="btn" onClick={exportAll} disabled={busy || meetings.length === 0}>
      {busy ? 'Exporting…' : 'Export all (JSON)'}
    </button>
  );
}
