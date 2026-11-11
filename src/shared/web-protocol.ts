/**
 * Protocol between the MeetNotes web panel (a page on its own origin) and the
 * extension. The page cannot read the extension's IndexedDB directly (different
 * origin), so a bridge content script — injected ONLY on the configured panel
 * origin — relays read-only requests to the service worker:
 *
 *   page ──window.postMessage──▶ web-bridge.js ──runtime.sendMessage──▶ background
 *   page ◀──window.postMessage── web-bridge.js ◀──────── response ───── background
 *
 * Everything stays inside the user's browser; the site's host never sees data.
 */
import type { MeetingRecord } from './db/schema';
import type { Result } from './messages';
import type { TranscriptSegment } from './types';

export const PAGE_SOURCE = 'meetnotes-web';
export const BRIDGE_SOURCE = 'meetnotes-extension';
export const BRIDGE_PROTOCOL_VERSION = 1;

export type WebRequest = { readonly type: 'list-meetings' } | { readonly type: 'get-meeting'; readonly meetingId: string };

export interface MeetingDetail {
  readonly meeting: MeetingRecord;
  readonly segments: readonly TranscriptSegment[];
}

export interface WebResponseMap {
  'list-meetings': readonly MeetingRecord[];
  'get-meeting': MeetingDetail;
}

// page → bridge
export type PageMessage =
  | { readonly source: typeof PAGE_SOURCE; readonly kind: 'hello' }
  | { readonly source: typeof PAGE_SOURCE; readonly kind: 'request'; readonly id: string; readonly request: WebRequest };

// bridge → page
export type BridgeMessage =
  | {
      readonly source: typeof BRIDGE_SOURCE;
      readonly kind: 'ready';
      readonly protocol: number;
      readonly extensionVersion: string;
    }
  | { readonly source: typeof BRIDGE_SOURCE; readonly kind: 'response'; readonly id: string; readonly result: Result<unknown> };

// bridge → background
export interface BackgroundWebRequest {
  readonly type: 'web/request';
  readonly request: WebRequest;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function isWebRequest(v: unknown): v is WebRequest {
  if (!isObject(v)) return false;
  if (v['type'] === 'list-meetings') return true;
  return v['type'] === 'get-meeting' && typeof v['meetingId'] === 'string' && v['meetingId'].length > 0;
}

export function isPageMessage(v: unknown): v is PageMessage {
  if (!isObject(v) || v['source'] !== PAGE_SOURCE) return false;
  if (v['kind'] === 'hello') return true;
  return v['kind'] === 'request' && typeof v['id'] === 'string' && isWebRequest(v['request']);
}

export function isBridgeMessage(v: unknown): v is BridgeMessage {
  if (!isObject(v) || v['source'] !== BRIDGE_SOURCE) return false;
  return v['kind'] === 'ready' || (v['kind'] === 'response' && typeof v['id'] === 'string' && isObject(v['result']));
}

export function isBackgroundWebRequest(v: unknown): v is BackgroundWebRequest {
  return isObject(v) && v['type'] === 'web/request' && isWebRequest(v['request']);
}
