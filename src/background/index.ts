/**
 * Service worker entry. All listeners are registered synchronously at top level
 * (required for MV3 so events wake the worker). No network access anywhere:
 * the extension CSP sets connect-src 'none'.
 */
import { createLogger, errorMessage } from '../shared/logger';
import { fail, isContentEvent, isPanelRequest, ok, type PanelRequest, type Result } from '../shared/messages';
import { CaptureRegistry } from './capture-registry';
import { CaptureService } from './capture-service';
import { PanelHub } from './panel-hub';
import { openDatabase } from '../shared/db/idb';
import { IndexedDbMeetingRepository } from '../shared/db/meeting-repository';
import { IndexedDbTranscriptRepository } from '../shared/db/transcript-repository';
import { MeetingService } from './meeting-service';
import { SettingsStore } from './settings-store';
import { TranscriptService } from './transcript-service';

const logger = createLogger('background');
const MEET_ORIGIN = 'https://meet.google.com';

const registry = new CaptureRegistry(chrome.storage.session, logger.child('registry'));
const hub = new PanelHub(logger.child('panel-hub'));
// One lazily-opened connection, reopened if it ever fails or closes.
let dbPromise: Promise<IDBDatabase> | null = null;
const database = (): Promise<IDBDatabase> => {
  dbPromise ??= openDatabase().then(
    (db) => {
      db.onclose = () => {
        dbPromise = null;
      };
      return db;
    },
    (error: unknown) => {
      dbPromise = null;
      logger.error('db.open-failed', { error });
      throw error;
    },
  );
  return dbPromise;
};

const transcripts = new TranscriptService(new IndexedDbTranscriptRepository(database), Date.now, logger.child('transcripts'));
const meetings = new MeetingService(new IndexedDbMeetingRepository(database), transcripts, Date.now, logger.child('meetings'));
const service = new CaptureService(registry, transcripts, meetings, hub, new SettingsStore(chrome.storage.local));

// Every service-worker start: close meetings a crash/browser restart left "active".
service.recover().catch((error: unknown) => logger.error('recover.failed', { error }));

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error: unknown) => {
    logger.error('side-panel.behavior-failed', { error });
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (!hub.accept(port)) port.disconnect();
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;

  if (isContentEvent(message)) {
    const tabId = sender.tab?.id;
    const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : undefined);
    if (tabId === undefined || origin !== MEET_ORIGIN) return false;
    service
      .handleContentEvent(tabId, message)
      .then(() => sendResponse(ok(null)))
      .catch((error: unknown) => {
        logger.error('content-event.failed', { type: message.type, error });
        sendResponse(fail(errorMessage(error)));
      });
    return true;
  }

  if (isPanelRequest(message) && sender.tab === undefined) {
    handlePanelRequest(message)
      .then(sendResponse)
      .catch((error: unknown) => sendResponse(fail(errorMessage(error))));
    return true;
  }

  return false;
});

async function handlePanelRequest(request: PanelRequest): Promise<Result<unknown>> {
  try {
    switch (request.type) {
      case 'panel/get-state':
        return ok(await service.getSnapshot(request.tabId));
      case 'panel/start-capture':
        return ok(await service.start(request.tabId));
      case 'panel/stop-capture':
        return ok(await service.stop(request.tabId));
      case 'panel/get-caption-language':
        return ok(await service.getCaptionLanguage(request.tabId, request.withOptions));
      case 'panel/set-caption-language':
        return ok(await service.setCaptionLanguage(request.tabId, request.language));
      case 'panel/get-diagnostics':
        return ok(await service.getDiagnostics(request.tabId));
      case 'panel/get-settings':
        return ok(await service.getSettings());
      case 'panel/update-settings':
        return ok(await service.updateSettings(request.patch));
    }
  } catch (error) {
    logger.warn('panel-request.failed', { type: request.type, error });
    return fail(errorMessage(error));
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void service.onTabRemoved(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') void service.onTabLoading(tabId);
});
