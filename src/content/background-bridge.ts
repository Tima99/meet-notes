import { createLogger, errorMessage, type Logger } from '../shared/logger';
import { isContentCommand, type ContentCommand, type ContentEvent } from '../shared/messages';

export type CommandHandler = (command: ContentCommand) => Promise<unknown>;

/** Thrown when the extension was reloaded/updated and this content script is orphaned. */
export class ExtensionContextInvalidatedError extends Error {
  constructor() {
    super('Extension context invalidated');
    this.name = 'ExtensionContextInvalidatedError';
  }
}

export interface BackgroundBridge {
  send(event: ContentEvent): Promise<void>;
  onCommand(handler: CommandHandler): void;
  isContextValid(): boolean;
}

/** chrome.runtime messaging, isolated behind an interface so the controller stays testable. */
export class ChromeBackgroundBridge implements BackgroundBridge {
  constructor(private readonly logger: Logger = createLogger('bridge')) {}

  isContextValid(): boolean {
    try {
      return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  async send(event: ContentEvent): Promise<void> {
    if (!this.isContextValid()) throw new ExtensionContextInvalidatedError();
    try {
      await chrome.runtime.sendMessage(event);
    } catch (error) {
      if (!this.isContextValid() || /context invalidated/i.test(errorMessage(error))) {
        throw new ExtensionContextInvalidatedError();
      }
      throw error;
    }
  }

  onCommand(handler: CommandHandler): void {
    chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || !isContentCommand(message)) return false;
      handler(message)
        .then((result) => sendResponse(result))
        .catch((error: unknown) => {
          this.logger.error('command.failed', { type: message.type, error });
          sendResponse({ ok: false, error: errorMessage(error) });
        });
      return true; // async response
    });
  }
}
