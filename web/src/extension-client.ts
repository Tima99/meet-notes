/**
 * Talks to the MeetNotes extension through its bridge content script, which
 * Chrome injects on this site only if this origin was configured when the
 * extension was built. All data arrives via window.postMessage inside this
 * browser — nothing is fetched from any server.
 */
import {
  isBridgeMessage,
  PAGE_SOURCE,
  type PageMessage,
  type WebRequest,
  type WebResponseMap,
} from '../../src/shared/web-protocol';

export interface ExtensionInfo {
  readonly extensionVersion: string;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class MeetNotesClient {
  private readonly pending = new Map<string, Pending>();
  private readyListener: ((info: ExtensionInfo) => void) | null = null;
  private readonly origin: string;

  constructor(private readonly win: Window = window) {
    this.origin = win.location.origin;
    win.addEventListener('message', this.onMessage);
  }

  /** Resolves with the extension's info, or null if no bridge answers in time. */
  connect(timeoutMs = 3000): Promise<ExtensionInfo | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (info: ExtensionInfo | null): void => {
        if (settled) return;
        settled = true;
        clearInterval(ping);
        clearTimeout(timer);
        this.readyListener = null;
        resolve(info);
      };
      this.readyListener = finish;
      const hello = (): void => this.post({ source: PAGE_SOURCE, kind: 'hello' });
      const ping = setInterval(hello, 300);
      const timer = setTimeout(() => finish(null), timeoutMs);
      hello();
    });
  }

  request<T extends WebRequest['type']>(request: Extract<WebRequest, { type: T }>, timeoutMs = 20_000): Promise<WebResponseMap[T]> {
    const id = crypto.randomUUID();
    return new Promise<WebResponseMap[T]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The MeetNotes extension did not answer. Is it still enabled?'));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as WebResponseMap[T]), reject, timer });
      this.post({ source: PAGE_SOURCE, kind: 'request', id, request });
    });
  }

  dispose(): void {
    this.win.removeEventListener('message', this.onMessage);
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  private post(message: PageMessage): void {
    this.win.postMessage(message, this.origin);
  }

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    if (event.source !== this.win || event.origin !== this.origin || !isBridgeMessage(event.data)) return;
    const message = event.data;
    if (message.kind === 'ready') {
      this.readyListener?.({ extensionVersion: message.extensionVersion });
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.result.ok) pending.resolve(message.result.data);
    else pending.reject(new Error(message.result.error));
  };
}
