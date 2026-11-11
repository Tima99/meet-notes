// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackgroundBridge, CommandHandler } from '../src/content/background-bridge';
import { CaptureController } from '../src/content/capture-controller';
import { CaptionObserver } from '../src/content/captions/caption-observer';
import { MeetCaptionParser } from '../src/content/captions/caption-parser';
import { CaptionTracker } from '../src/content/captions/caption-tracker';
import { MeetCaptionLanguage } from '../src/content/meet/caption-language';
import { findCaptionPanel } from '../src/content/meet/caption-panel';
import { MeetCaptionsToggle } from '../src/content/meet/captions-toggle';
import { MeetDetector } from '../src/content/meet/meet-detector';
import { CssCaptionHider } from '../src/content/ui/caption-hider';
import type { IndicatorState } from '../src/content/ui/capture-indicator';
import type { ContentCommand, ContentEvent } from '../src/shared/messages';
import { FakeMeet, settle } from './fixtures/fake-meet';

const startCmd = (meetingId: string, hideCaptionsOverlay = true): ContentCommand => ({
  type: 'content/start-capture',
  meetingId,
  startedAt: 1,
  settings: { hideCaptionsOverlay },
});
const isHidden = (el: Element | null) => el?.closest('[data-meetnotes-hidden]') != null;

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

class FakeBridge implements BackgroundBridge {
  readonly sent: ContentEvent[] = [];
  handler: CommandHandler | null = null;
  async send(event: ContentEvent): Promise<void> {
    this.sent.push(event);
  }
  onCommand(handler: CommandHandler): void {
    this.handler = handler;
  }
  isContextValid(): boolean {
    return true;
  }
  ofType<T extends ContentEvent['type']>(type: T): Extract<ContentEvent, { type: T }>[] {
    return this.sent.filter((e): e is Extract<ContentEvent, { type: T }> => e.type === type);
  }
}

describe('CaptureController', () => {
  let bridge: FakeBridge;
  let indicator: (IndicatorState | 'hidden')[];
  let controller: CaptureController;
  let meet: FakeMeet;

  beforeEach(() => {
    document.body.innerHTML = '';
    meet = new FakeMeet(document);
    bridge = new FakeBridge();
    indicator = [];
    const parser = new MeetCaptionParser(undefined, silent);
    const detector = new MeetDetector({
      document,
      getUrl: () => 'https://meet.google.com/abc-defg-hij',
      findCaptionRegion: (root) => parser.findRegion(root),
      pollIntervalMs: 10,
      logger: silent,
    });
    let id = 0;
    controller = new CaptureController({
      detector,
      bridge,
      indicator: { show: (s) => indicator.push(s), hide: () => indicator.push('hidden') },
      captionsToggle: new MeetCaptionsToggle({ document, findCaptionRegion: (root) => parser.findRegion(root), pollMs: 5, timeoutMs: 300, logger: silent }),
      captionHider: new CssCaptionHider(document, silent),
      captionLanguage: new MeetCaptionLanguage({
        document,
        getRegion: () => parser.findRegion(document),
        getPanel: () => {
          const region = parser.findRegion(document);
          return region ? findCaptionPanel(region) : null;
        },
        pollMs: 5,
        logger: silent,
      }),
      clock: { now: () => Date.now() },
      window,
      logger: silent,
      tickIntervalMs: 10,
      meetingEndGraceMs: 30,
      createObserver: () => new CaptionObserver({ document, parser, clock: { now: () => Date.now() }, logger: silent }, { searchDelayMs: 1, revalidateDelayMs: 1 }),
      createTracker: (meetingId) => new CaptionTracker({ meetingId, idleFinalizeMs: 50 }, () => `seg-${++id}`, silent),
    });
    controller.init();
  });
  afterEach(() => controller.stop('user-stopped'));

  it('never captures until started', async () => {
    meet.enableCaptions();
    meet.addBlock('Alice', 'Private chatter before start');
    await settle(30);
    expect(bridge.ofType('content/segments')).toHaveLength(0);
  });

  it('captures after start, flushes final segments on stop, then reports capture-ended', async () => {
    meet.enableCaptions();
    const block = meet.addBlock('Alice', 'Hello');
    const res = await bridge.handler?.(startCmd('m1'));
    expect(res).toMatchObject({ ok: true, data: { capture: { meetingId: 'm1' } } });
    expect(indicator.at(-1)).toBe('capturing');
    meet.setText(block, 'Hello world');
    await settle(20);
    await bridge.handler?.({ type: 'content/stop-capture', reason: 'user-stopped' });

    const segments = bridge.ofType('content/segments').flatMap((e) => e.segments);
    expect(segments.at(-1)).toMatchObject({ meetingId: 'm1', text: 'Hello world', status: 'final' });
    const lastSegmentIdx = bridge.sent.findLastIndex((e) => e.type === 'content/segments');
    const endedIdx = bridge.sent.findIndex((e) => e.type === 'content/capture-ended');
    expect(endedIdx).toBeGreaterThan(lastSegmentIdx);
    expect(indicator.at(-1)).toBe('hidden');
  });

  it('shows the waiting indicator when captions are off', async () => {
    await bridge.handler?.(startCmd('m1'));
    expect(indicator.at(-1)).toBe('waiting-for-captions');
  });

  it('auto-stops when the call ends, but only after the call was seen', async () => {
    await bridge.handler?.(startCmd('m1'));
    await settle(60);
    expect(bridge.ofType('content/capture-ended')).toHaveLength(0); // never saw call controls

    document.body.insertAdjacentHTML('beforeend', '<button jsname="CQylAd"></button>');
    await settle(30);
    document.querySelector('[jsname="CQylAd"]')?.remove();
    await settle(100);
    expect(bridge.ofType('content/capture-ended')).toEqual([
      expect.objectContaining({ meetingId: 'm1', reason: 'meeting-ended' }),
    ]);
  });

  it('rejects a second, different capture in the same tab', async () => {
    await bridge.handler?.(startCmd('m1'));
    const res = await bridge.handler?.(startCmd('m2'));
    expect(res).toMatchObject({ ok: false });
  });

  it('turns captions on for the user and hides them, then restores both on stop', async () => {
    meet.addCaptionsButton();
    await bridge.handler?.(startCmd('m1'));
    await settle(80);
    expect(meet.region).not.toBeNull();
    expect(isHidden(meet.region)).toBe(true);
    expect(indicator.at(-1)).toBe('capturing');

    const region = meet.region;
    await bridge.handler?.({ type: 'content/stop-capture', reason: 'user-stopped' });
    expect(isHidden(region)).toBe(false);
    await settle(50);
    expect(meet.region).toBeNull(); // we turned them on, so we turned them off again
  });

  it('still captures hidden captions', async () => {
    meet.enableCaptions();
    const block = meet.addBlock('Alice', 'Hidden but');
    await bridge.handler?.(startCmd('m1'));
    expect(isHidden(meet.region)).toBe(true);
    meet.setText(block, 'Hidden but still captured');
    await settle(20);
    await bridge.handler?.({ type: 'content/stop-capture', reason: 'user-stopped' });
    const segments = bridge.ofType('content/segments').flatMap((e) => e.segments);
    expect(segments.at(-1)).toMatchObject({ text: 'Hidden but still captured', status: 'final' });
  });

  it('leaves captions on at stop if the user had them on already', async () => {
    meet.addCaptionsButton();
    meet.enableCaptions();
    await bridge.handler?.(startCmd('m1'));
    await bridge.handler?.({ type: 'content/stop-capture', reason: 'user-stopped' });
    await settle(50);
    expect(meet.region).not.toBeNull();
    expect(isHidden(meet.region)).toBe(false);
  });

  it('respects hideCaptionsOverlay = false and live setting changes', async () => {
    meet.enableCaptions();
    await bridge.handler?.(startCmd('m1', false));
    expect(isHidden(meet.region)).toBe(false);
    await bridge.handler?.({ type: 'content/apply-settings', settings: { hideCaptionsOverlay: true } });
    expect(isHidden(meet.region)).toBe(true);
    await bridge.handler?.({ type: 'content/apply-settings', settings: { hideCaptionsOverlay: false } });
    expect(isHidden(meet.region)).toBe(false);
  });

  it('keeps the waiting indicator if no captions button can be found', async () => {
    await bridge.handler?.(startCmd('m1'));
    await settle(350);
    expect(indicator.at(-1)).toBe('waiting-for-captions');
  });

  it('turns captions on when the user joins the call after starting in the lobby', async () => {
    await bridge.handler?.(startCmd('m1'));
    await settle(350); // lobby: no captions button yet
    expect(meet.region).toBeNull();
    meet.addCaptionsButton();
    document.body.insertAdjacentHTML('beforeend', '<button jsname="CQylAd"></button>');
    await settle(120);
    expect(meet.region).not.toBeNull();
    expect(isHidden(meet.region)).toBe(true);
  });

  it('hides the whole captions panel (language bar included) but never the video stage', async () => {
    meet.enableCaptions();
    await bridge.handler?.(startCmd('m1'));
    expect(meet.panel?.hasAttribute('data-meetnotes-hidden')).toBe(true);
    expect(isHidden(meet.languagePicker)).toBe(true);
    expect(isHidden(meet.tile)).toBe(false);
    expect(meet.stage.hasAttribute('data-meetnotes-hidden')).toBe(false);
  });

  it('reads and changes the caption language through Meet\'s hidden picker', async () => {
    meet.enableCaptions();
    await bridge.handler?.(startCmd('m1'));
    const current = await bridge.handler?.({ type: 'content/get-caption-language', withOptions: false });
    expect(current).toEqual({ ok: true, data: { current: 'English', options: [] } });
    expect(meet.menuOpen).toBe(false); // reading the current language never opens Meet's menu

    const listed = await bridge.handler?.({ type: 'content/get-caption-language', withOptions: true });
    expect(listed).toMatchObject({ ok: true, data: { options: ['English', 'Hindi', 'Español (México)', 'Français'] } });
    expect(meet.menuOpen).toBe(false); // closed again

    const changed = await bridge.handler?.({ type: 'content/set-caption-language', language: 'Hindi' });
    expect(changed).toMatchObject({ ok: true, data: { current: 'Hindi' } });
    expect(meet.language).toBe('Hindi');
    expect(isHidden(meet.region)).toBe(true); // still hidden afterwards
  });

  it('reports a clear error for the language picker when captions are off', async () => {
    const res = await bridge.handler?.({ type: 'content/get-caption-language', withOptions: false });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('Captions are off') });
  });

  it('on stop, turns captions off with the toolbar CC button, never the "Jump to bottom of captions" button', async () => {
    const cc = meet.addCaptionsButton();
    let ccClicks = 0;
    cc.addEventListener('click', () => ccClicks++);
    await bridge.handler?.(startCmd('m1'));
    await settle(80);
    expect(ccClicks).toBe(1);
    await bridge.handler?.({ type: 'content/stop-capture', reason: 'user-stopped' });
    expect(ccClicks).toBe(2);
  });

  it('switches hide mode on BEFORE turning captions on, and off at stop', async () => {
    const cc = meet.addCaptionsButton();
    let modeWhenClicked: boolean | null = null;
    cc.addEventListener('click', () => {
      modeWhenClicked ??= document.documentElement.hasAttribute('data-meetnotes-captions-hidden');
    });
    await bridge.handler?.(startCmd('m1'));
    await settle(80);
    expect(modeWhenClicked).toBe(true);
    await bridge.handler?.({ type: 'content/stop-capture', reason: 'user-stopped' });
    expect(document.documentElement.hasAttribute('data-meetnotes-captions-hidden')).toBe(false);
  });

  it('restarts captions that were already on so Meet lays out the hidden panel (and leaves them on at stop)', async () => {
    const cc = meet.addCaptionsButton();
    meet.enableCaptions();
    const clicks: boolean[] = [];
    cc.addEventListener('click', () => clicks.push(document.documentElement.hasAttribute('data-meetnotes-captions-hidden')));
    await bridge.handler?.(startCmd('m1'));
    await settle(150);
    expect(clicks).toEqual([true, true]); // off + on, both with hide mode already active
    expect(meet.region).not.toBeNull();
    expect(isHidden(meet.region)).toBe(true);

    await bridge.handler?.({ type: 'content/stop-capture', reason: 'user-stopped' });
    await settle(50);
    expect(clicks).toHaveLength(2); // user had them on: not turned off at stop
    expect(meet.region).not.toBeNull();
  });

  it('restarts captions when the hide setting is toggled mid-meeting', async () => {
    const cc = meet.addCaptionsButton();
    meet.enableCaptions();
    await bridge.handler?.(startCmd('m1', false));
    await settle(50);
    let clicks = 0;
    cc.addEventListener('click', () => clicks++);
    await bridge.handler?.({ type: 'content/apply-settings', settings: { hideCaptionsOverlay: true } });
    await settle(150);
    expect(clicks).toBe(2);
    expect(isHidden(meet.region)).toBe(true);
  });

  describe('newer Meet: the CC button opens a "Live captions / Translate speech" popup', () => {
    it('turns captions on via "Live captions", closes the popup, never touches "Translate speech"', async () => {
      meet.addCaptionsButton({ popup: true });
      await bridge.handler?.(startCmd('m1'));
      await settle(450);
      expect(meet.region).not.toBeNull();
      expect(isHidden(meet.region)).toBe(true);
      expect(meet.captionsPopup).toBeNull();
      expect(meet.translateClicks).toBe(0);

      await bridge.handler?.({ type: 'content/stop-capture', reason: 'user-stopped' });
      await settle(50);
      expect(meet.region).toBeNull(); // we turned them on → turned off again
      expect(meet.captionsPopup).toBeNull();
    });

    it('restarts captions that were already on through the popup and closes it', async () => {
      meet.addCaptionsButton({ popup: true });
      meet.enableCaptions();
      await bridge.handler?.(startCmd('m1'));
      await settle(900);
      expect(meet.region).not.toBeNull();
      expect(isHidden(meet.region)).toBe(true);
      expect(meet.captionsPopup).toBeNull();
      expect(meet.translateClicks).toBe(0);
    });
  });
});
