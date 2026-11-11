/**
 * Content script entry — runs on https://meet.google.com/*.
 * Composition root: builds the modules and hands them to the controller.
 * Nothing is captured until the user presses Start in the side panel.
 */
import { randomId, systemClock } from '../shared/clock';
import { createLogger } from '../shared/logger';
import { ChromeBackgroundBridge } from './background-bridge';
import { CaptureController } from './capture-controller';
import { CaptionObserver } from './captions/caption-observer';
import { MeetCaptionParser } from './captions/caption-parser';
import { CaptionTracker } from './captions/caption-tracker';
import { MeetCaptionLanguage } from './meet/caption-language';
import { findCaptionPanel } from './meet/caption-panel';
import { collectLayoutDiagnostics } from './meet/layout-diagnostics';
import { MeetCaptionsToggle } from './meet/captions-toggle';
import { MeetDetector } from './meet/meet-detector';
import { CssCaptionHider } from './ui/caption-hider';
import { CaptureIndicator } from './ui/capture-indicator';

const GUARD = '__meetNotesContentLoaded';
type GuardedWindow = Window & { [GUARD]?: boolean };

function bootstrap(): void {
  const win = window as GuardedWindow;
  if (win[GUARD]) return;
  win[GUARD] = true;

  const logger = createLogger('content');
  const parser = new MeetCaptionParser(undefined, logger.child('parser'));
  const detector = new MeetDetector({
    document,
    getUrl: () => location.href,
    findCaptionRegion: (root) => parser.findRegion(root),
    logger: logger.child('detector'),
  });

  const controller = new CaptureController({
    detector,
    bridge: new ChromeBackgroundBridge(logger.child('bridge')),
    indicator: new CaptureIndicator(document),
    captionsToggle: new MeetCaptionsToggle({
      document,
      findCaptionRegion: (root) => parser.findRegion(root),
      logger: logger.child('captions-toggle'),
    }),
    captionHider: new CssCaptionHider(document, logger.child('caption-hider')),
    captionLanguage: new MeetCaptionLanguage({
      document,
      getRegion: () => parser.findRegion(document),
      getPanel: () => {
        const region = parser.findRegion(document);
        return region ? findCaptionPanel(region) : null;
      },
      logger: logger.child('caption-language'),
    }),
    diagnostics: () => collectLayoutDiagnostics(document, parser.findRegion(document)),
    clock: systemClock,
    window,
    logger: logger.child('controller'),
    createObserver: () => new CaptionObserver({ document, parser, clock: systemClock, logger: logger.child('observer') }),
    createTracker: (meetingId) => new CaptionTracker({ meetingId }, randomId, logger.child('tracker')),
  });
  controller.init();
}

bootstrap();
