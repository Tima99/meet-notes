import { createLogger, type Logger } from '../shared/logger';
import { PANEL_PORT_NAME, type PanelEvent } from '../shared/messages';

/** Pushes live updates to every open side panel over long-lived ports. */
export class PanelHub {
  private readonly ports = new Set<chrome.runtime.Port>();

  constructor(private readonly logger: Logger = createLogger('panel-hub')) {}

  accept(port: chrome.runtime.Port): boolean {
    if (port.name !== PANEL_PORT_NAME || port.sender?.id !== chrome.runtime.id) return false;
    this.ports.add(port);
    port.onDisconnect.addListener(() => this.ports.delete(port));
    return true;
  }

  broadcast(event: PanelEvent): void {
    for (const port of this.ports) {
      try {
        port.postMessage(event);
      } catch (error) {
        this.logger.debug('post.failed', { error });
        this.ports.delete(port);
      }
    }
  }
}
