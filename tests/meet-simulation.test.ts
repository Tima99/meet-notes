// @vitest-environment jsdom
/**
 * End-to-end: fake Meet DOM → real MutationObservers → parser → tracker.
 * Walks through every Phase 1 scenario in a single simulated meeting.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CaptionObserver } from '../src/content/captions/caption-observer';
import { MeetCaptionParser } from '../src/content/captions/caption-parser';
import { CaptionTracker } from '../src/content/captions/caption-tracker';
import type { TranscriptSegment } from '../src/shared/types';
import { FakeMeet, settle } from './fixtures/fake-meet';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

function harness(options: { obfuscated?: boolean } = {}) {
  document.body.innerHTML = '';
  let now = 0;
  let ids = 0;
  const clock = { now: () => now };
  const meet = new FakeMeet(document, options);
  const tracker = new CaptionTracker({ meetingId: 'meeting-1' }, () => `s${++ids}`, silent);
  const store = new Map<string, TranscriptSegment>();
  tracker.subscribe(({ segment }) => store.set(segment.id, segment));
  const observer = new CaptionObserver(
    { document, parser: new MeetCaptionParser(undefined, silent), clock, logger: silent },
    { searchDelayMs: 1, revalidateDelayMs: 1 },
  );
  observer.start((e) => {
    if (e.kind === 'snapshot') tracker.ingest(e.blocks, e.at);
    else if (e.kind === 'region-lost') tracker.flush(e.at);
  });
  /** Deliver pending DOM mutations at the current time, then let `ms` pass. */
  const advance = async (ms: number) => {
    await settle(10);
    now += ms;
    tracker.tick(now);
  };
  const transcript = () => [...store.values()].sort((a, b) => a.sequence - b.sequence);
  return { meet, tracker, observer, advance, transcript, finish: () => { tracker.flush(now); observer.stop(); } };
}

describe('simulated meeting', () => {
  let finish: (() => void) | null = null;
  afterEach(() => finish?.());

  it.each([{ obfuscated: false }, { obfuscated: true }])('produces a clean transcript (obfuscated DOM: $obfuscated)', async (opts) => {
    const h = harness(opts);
    finish = h.finish;
    const { meet, advance } = h;

    // Captions start disabled; user enables them.
    await advance(100);
    meet.enableCaptions();

    // Alice speaks; words arrive incrementally with a revision.
    const a1 = meet.addBlock('Alice', 'Good');
    for (const t of ['Good morning', 'Good morning every', 'Good morning everyone, thanks for joining']) {
      await advance(200);
      meet.setText(a1, t);
    }
    // Bob replies in a new block (different speaker, consecutive captions).
    await advance(300);
    const b1 = meet.addBlock('Bob', 'Morning');
    await advance(200);
    meet.setText(b1, 'Morning Alice');
    await advance(2500); // Alice's block is superseded + stable → final

    // Meet re-renders the whole list (must not duplicate anything).
    meet.rerenderAll();
    await advance(100);

    // Old block scrolls out of the DOM.
    const first = meet.blocks[0];
    if (!first) throw new Error('missing block');
    meet.removeBlock(first);
    await advance(2000);

    // Captions toggled off then on (open segments finalized, nothing duplicated).
    meet.disableCaptions();
    await advance(500);
    meet.enableCaptions();
    const c1 = meet.addBlock('Carol', 'Can');
    await advance(200);
    meet.setText(c1, 'Can everyone see my screen?');
    await advance(6000); // idle → final

    expect(h.transcript().map((s) => [s.speaker, s.text, s.status])).toEqual([
      ['Alice', 'Good morning everyone, thanks for joining', 'final'],
      ['Bob', 'Morning Alice', 'final'],
      ['Carol', 'Can everyone see my screen?', 'final'],
    ]);
    const seq = h.transcript().map((s) => s.sequence);
    expect(seq).toEqual([...seq].sort((x, y) => x - y));
  });
});
