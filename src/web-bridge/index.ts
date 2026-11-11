/**
 * Web-panel bridge. Chrome injects this ONLY on the origins listed in
 * MEETNOTES_WEB_ORIGINS at build time. It relays read-only requests from that
 * page to the service worker and posts the answers back to the same page.
 * Data never leaves the browser.
 */
import { errorMessage } from '../shared/logger';
import { fail, isResult, type Result } from '../shared/messages';
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SOURCE,
  isPageMessage,
  type BackgroundWebRequest,
  type BridgeMessage,
} from '../shared/web-protocol';

export interface BridgeDeps {
  readonly window: Window;
  readonly sendToBackground: (message: BackgroundWebRequest) => Promise<unknown>;
  readonly extensionVersion: string;
}

export function startBridge({ window: win, sendToBackground, extensionVersion }: BridgeDeps): () => void {
  const origin = win.location.origin;
  const post = (message: BridgeMessage): void => win.postMessage(message, origin);
  const announce = (): void => post({ source: BRIDGE_SOURCE, kind: 'ready', protocol: BRIDGE_PROTOCOL_VERSION, extensionVersion });

  const onMessage = (event: MessageEvent<unknown>): void => {
    // Only messages from this very page (not iframes, not other origins).
    if (event.source !== win || event.origin !== origin || !isPageMessage(event.data)) return;
    const message = event.data;
    if (message.kind === 'hello') {
      announce();
      return;
    }
    sendToBackground({ type: 'web/request', request: message.request })
      .then((response): Result<unknown> => (isResult(response) ? response : fail('No response from MeetNotes.')))
      .catch((error: unknown) => fail(errorMessage(error)))
      .then((result) => post({ source: BRIDGE_SOURCE, kind: 'response', id: message.id, result }));
  };

  win.addEventListener('message', onMessage);
  announce();
  return () => win.removeEventListener('message', onMessage);
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  startBridge({
    window,
    sendToBackground: (message) => chrome.runtime.sendMessage(message),
    extensionVersion: chrome.runtime.getManifest().version,
  });
}
