// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { MeetCaptionParser } from '../src/content/captions/caption-parser';
import { detectInCall, MeetDetector, parseMeetCode, readMeetTitle } from '../src/content/meet/meet-detector';
import { FakeMeet } from './fixtures/fake-meet';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

describe('parseMeetCode', () => {
  it.each([
    ['https://meet.google.com/abc-defg-hij', 'abc-defg-hij'],
    ['https://meet.google.com/abc-defg-hij?authuser=1', 'abc-defg-hij'],
    ['https://meet.google.com/ABC-DEFG-HIJ/', 'abc-defg-hij'],
    ['https://meet.google.com/meet/zny-tpve-aja', 'zny-tpve-aja'],
    ['https://meet.google.com/meet/zny-tpve-aja?authuser=0', 'zny-tpve-aja'],
    ['https://meet.google.com/abc-defg-hijk', null],
    ['https://meet.google.com/', null],
    ['https://meet.google.com/landing', null],
    ['https://example.com/abc-defg-hij', null],
    ['not a url', null],
  ])('%s → %s', (url, expected) => expect(parseMeetCode(url)).toBe(expected));
});

describe('readMeetTitle', () => {
  it('strips the Meet prefix and ignores bare codes', () => {
    expect(readMeetTitle('Meet – Weekly sync', 'abc-defg-hij')).toBe('Weekly sync');
    expect(readMeetTitle('Meet - abc-defg-hij', 'abc-defg-hij')).toBeNull();
    expect(readMeetTitle('Google Meet', null)).toBeNull();
  });
});

describe('MeetDetector', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.title = 'Meet - abc-defg-hij';
  });

  it('detects in-call state from the leave-call icon ligature (locale independent)', () => {
    expect(detectInCall(document)).toBe(false);
    document.body.innerHTML = '<button aria-label="Anruf verlassen"><i class="google-symbols">call_end</i></button>';
    expect(detectInCall(document)).toBe(true);
  });

  it('reports status changes', () => {
    const parser = new MeetCaptionParser(undefined, silent);
    const detector = new MeetDetector({
      document,
      getUrl: () => 'https://meet.google.com/abc-defg-hij',
      findCaptionRegion: (root) => parser.findRegion(root),
      logger: silent,
    });
    const seen: boolean[] = [];
    detector.start((s) => seen.push(s.captionsVisible));
    expect(detector.status).toMatchObject({ meetCode: 'abc-defg-hij', inCall: false, captionsVisible: false });
    new FakeMeet(document).enableCaptions();
    document.body.insertAdjacentHTML('beforeend', '<button jsname="CQylAd"></button>');
    detector.poll();
    detector.stop();
    expect(detector.status).toMatchObject({ inCall: true, captionsVisible: true });
    expect(seen).toEqual([true]);
  });
});
