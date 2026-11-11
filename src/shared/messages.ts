/**
 * Typed message protocol between the three extension contexts.
 *
 *   side panel ──PanelRequest──▶ background ──ContentCommand──▶ content script
 *   side panel ◀──PanelEvent (port)── background ◀──ContentEvent── content script
 */
import type {
  CaptionLanguageInfo,
  CaptureEndReason,
  ContentCaptureState,
  MeetPageStatus,
  TabState,
  TranscriptSegment,
} from './types';
import type { CaptureSettings } from './settings';

export type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const fail = <T = never>(error: string): Result<T> => ({ ok: false, error });

// ── side panel → background ────────────────────────────────────────────────
export type PanelRequest =
  | { readonly type: 'panel/get-state'; readonly tabId: number }
  | { readonly type: 'panel/start-capture'; readonly tabId: number }
  | { readonly type: 'panel/stop-capture'; readonly tabId: number }
  | { readonly type: 'panel/get-caption-language'; readonly tabId: number; readonly withOptions: boolean }
  | { readonly type: 'panel/set-caption-language'; readonly tabId: number; readonly language: string }
  | { readonly type: 'panel/get-diagnostics'; readonly tabId: number }
  | { readonly type: 'panel/get-settings' }
  | { readonly type: 'panel/update-settings'; readonly patch: Partial<CaptureSettings> };

export interface PanelStateSnapshot {
  readonly state: TabState;
  readonly segments: readonly TranscriptSegment[];
}

export interface PanelResponseMap {
  'panel/get-state': PanelStateSnapshot;
  'panel/start-capture': PanelStateSnapshot;
  'panel/stop-capture': PanelStateSnapshot;
  'panel/get-caption-language': CaptionLanguageInfo;
  'panel/set-caption-language': CaptionLanguageInfo;
  'panel/get-diagnostics': string;
  'panel/get-settings': CaptureSettings;
  'panel/update-settings': CaptureSettings;
}

// ── background → content ───────────────────────────────────────────────────
export type ContentCommand =
  | {
      readonly type: 'content/start-capture';
      readonly meetingId: string;
      readonly startedAt: number;
      readonly settings: CaptureSettings;
    }
  | { readonly type: 'content/apply-settings'; readonly settings: CaptureSettings }
  | { readonly type: 'content/get-caption-language'; readonly withOptions: boolean }
  | { readonly type: 'content/get-diagnostics' }
  | { readonly type: 'content/set-caption-language'; readonly language: string }
  | { readonly type: 'content/stop-capture'; readonly reason: CaptureEndReason }
  | { readonly type: 'content/get-status' };

export interface ContentStatusReport {
  readonly page: MeetPageStatus;
  readonly capture: ContentCaptureState | null;
}

// ── content → background ───────────────────────────────────────────────────
export type ContentEvent =
  | { readonly type: 'content/status'; readonly report: ContentStatusReport }
  | { readonly type: 'content/segments'; readonly segments: readonly TranscriptSegment[] }
  | {
      readonly type: 'content/capture-ended';
      readonly meetingId: string;
      readonly reason: CaptureEndReason;
      readonly endedAt: number;
    };

// ── background → side panel (via long-lived port) ──────────────────────────
export const PANEL_PORT_NAME = 'meetnotes/sidepanel';

export type PanelEvent =
  | { readonly type: 'bg/tab-state'; readonly state: TabState }
  | { readonly type: 'bg/segments'; readonly tabId: number; readonly segments: readonly TranscriptSegment[] };

// ── runtime guards (messages arrive as `unknown`) ──────────────────────────
function hasType(value: unknown): value is { type: string } {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

const PANEL_REQUEST_TYPES = new Set<string>([
  'panel/get-state',
  'panel/start-capture',
  'panel/stop-capture',
  'panel/get-caption-language',
  'panel/set-caption-language',
  'panel/get-diagnostics',
  'panel/get-settings',
  'panel/update-settings',
]);
const CONTENT_COMMAND_TYPES = new Set<string>([
  'content/start-capture',
  'content/apply-settings',
  'content/get-caption-language',
  'content/set-caption-language',
  'content/get-diagnostics',
  'content/stop-capture',
  'content/get-status',
]);
const CONTENT_EVENT_TYPES = new Set<string>(['content/status', 'content/segments', 'content/capture-ended']);
const PANEL_EVENT_TYPES = new Set<string>(['bg/tab-state', 'bg/segments']);

export const isPanelRequest = (v: unknown): v is PanelRequest => hasType(v) && PANEL_REQUEST_TYPES.has(v.type);
export const isContentCommand = (v: unknown): v is ContentCommand => hasType(v) && CONTENT_COMMAND_TYPES.has(v.type);
export const isContentEvent = (v: unknown): v is ContentEvent => hasType(v) && CONTENT_EVENT_TYPES.has(v.type);
export const isPanelEvent = (v: unknown): v is PanelEvent => hasType(v) && PANEL_EVENT_TYPES.has(v.type);

export function isResult(value: unknown): value is Result<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean';
}
