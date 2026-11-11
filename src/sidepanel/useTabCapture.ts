import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../shared/logger';
import { isPanelEvent, PANEL_PORT_NAME, type PanelStateSnapshot } from '../shared/messages';
import type { TabState, TranscriptSegment } from '../shared/types';
import { request } from './api';

export interface TabCapture {
  readonly state: TabState | null;
  readonly segments: readonly TranscriptSegment[];
  readonly busy: boolean;
  readonly error: string | null;
  start(): void;
  stop(): void;
  refresh(): void;
}

function mergeSegments(
  current: ReadonlyMap<string, TranscriptSegment>,
  incoming: readonly TranscriptSegment[],
  meetingId: string | null,
): Map<string, TranscriptSegment> {
  const next = new Map(current);
  for (const segment of incoming) {
    if (meetingId && segment.meetingId !== meetingId) continue;
    const existing = next.get(segment.id);
    if (existing && existing.revision >= segment.revision) continue;
    next.set(segment.id, segment);
  }
  return next;
}

/** Live state + transcript for one tab, kept in sync over a port to the service worker. */
export function useTabCapture(tabId: number | null): TabCapture {
  const [state, setState] = useState<TabState | null>(null);
  const [segments, setSegments] = useState<Map<string, TranscriptSegment>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meetingRef = useRef<string | null>(null);

  const apply = useCallback((snapshot: PanelStateSnapshot) => {
    setState(snapshot.state);
    const meetingId = snapshot.state.capture?.meetingId ?? snapshot.segments[0]?.meetingId ?? null;
    meetingRef.current = meetingId;
    setSegments(mergeSegments(new Map(), snapshot.segments, meetingId));
  }, []);

  const refresh = useCallback(() => {
    if (tabId === null) return;
    request({ type: 'panel/get-state', tabId })
      .then((snapshot) => {
        apply(snapshot);
        setError(null);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [tabId, apply]);

  useEffect(() => {
    setState(null);
    setSegments(new Map());
    meetingRef.current = null;
    refresh();
  }, [refresh]);

  // Live updates from the service worker; reconnect if the worker restarts.
  useEffect(() => {
    if (tabId === null) return;
    let port: chrome.runtime.Port | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = (): void => {
      port = chrome.runtime.connect({ name: PANEL_PORT_NAME });
      port.onMessage.addListener((message: unknown) => {
        if (!isPanelEvent(message)) return;
        if (message.type === 'bg/tab-state' && message.state.tabId === tabId) {
          setState(message.state);
          const meetingId = message.state.capture?.meetingId;
          if (meetingId && meetingId !== meetingRef.current) {
            meetingRef.current = meetingId;
            setSegments(new Map());
          }
        } else if (message.type === 'bg/segments' && message.tabId === tabId) {
          const first = message.segments[0];
          if (first && meetingRef.current === null) meetingRef.current = first.meetingId;
          setSegments((current) => mergeSegments(current, message.segments, meetingRef.current));
        }
      });
      port.onDisconnect.addListener(() => {
        port = null;
        if (!disposed) reconnectTimer = setTimeout(connect, 1000);
      });
    };
    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      port?.disconnect();
    };
  }, [tabId]);

  const run = useCallback(
    (type: 'panel/start-capture' | 'panel/stop-capture') => {
      if (tabId === null) return;
      setBusy(true);
      request({ type, tabId })
        .then((snapshot) => {
          apply(snapshot);
          setError(null);
        })
        .catch((e: unknown) => setError(errorMessage(e)))
        .finally(() => setBusy(false));
    },
    [tabId, apply],
  );

  const ordered = [...segments.values()].sort((a, b) => a.sequence - b.sequence);
  return {
    state,
    segments: ordered,
    busy,
    error,
    start: () => run('panel/start-capture'),
    stop: () => run('panel/stop-capture'),
    refresh,
  };
}
