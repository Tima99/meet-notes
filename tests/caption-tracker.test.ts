import { describe, expect, it } from 'vitest';
import { CaptionTracker, classifyChange, DEFAULT_TRACKER_OPTIONS, findSlide, type TrackerEvent } from '../src/content/captions/caption-tracker';
import type { CaptionBlockSnapshot } from '../src/content/captions/caption-observer';
import type { TranscriptSegment } from '../src/shared/types';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

function setup(overrides: Partial<typeof DEFAULT_TRACKER_OPTIONS> = {}) {
  let n = 0;
  const tracker = new CaptionTracker({ meetingId: 'm1', ...overrides }, () => `seg-${++n}`, silent);
  const events: TrackerEvent[] = [];
  const latest = new Map<string, TranscriptSegment>();
  tracker.subscribe((e) => {
    events.push(e);
    latest.set(e.segment.id, e.segment);
  });
  const transcript = () => [...latest.values()].sort((a, b) => a.sequence - b.sequence);
  const finals = () => transcript().filter((s) => s.status === 'final');
  return { tracker, events, transcript, finals };
}

const b = (key: string, speaker: string, text: string): CaptionBlockSnapshot => ({ key, speaker, text });

describe('classifyChange', () => {
  const o = DEFAULT_TRACKER_OPTIONS;
  it('treats growth and tail revisions as revisions', () => {
    expect(classifyChange('Hello', 'Hello there', o).kind).toBe('revised');
    expect(classifyChange('I want to go to the store', 'I want to go to this store today', o).kind).toBe('revised');
  });
  it('treats corrections in the middle of the sentence as revisions', () => {
    expect(
      classifyChange(
        "Yeah, please go to the admin panel. There, usually a button. Click on it, and it's start person okay.",
        "Yeah, please go to the admin panel. They're usually a button. Click on it, and it's start person. Okay. So, when you are ready, let me know.",
        o,
      ).kind,
    ).toBe('revised');
  });
  it('treats early unstable text rewrites as revisions', () => {
    expect(classifyChange('Hi', 'I think so', o).kind).toBe('revised');
  });
  it('detects a slide (oldest sentence dropped)', () => {
    const prev = 'This is the first sentence. And here is the second one';
    const next = 'And here is the second one and more';
    const change = classifyChange(prev, next, o);
    expect(change).toEqual({ kind: 'slid', dropLength: prev.indexOf('And here') });
  });
  it('detects a reset (block cleared and restarted)', () => {
    expect(classifyChange('We should ship this on Friday afternoon', 'Okay next topic', o).kind).toBe('reset');
  });
  it('treats a hard shrink as reset so text is never silently lost', () => {
    expect(classifyChange('Yes I agree with that point entirely', 'Yes', o).kind).toBe('reset');
  });
  it('findSlide only matches on word boundaries', () => {
    expect(findSlide('abcdefghijklmnopqrstuvwxyz', 'efghijklmnopqrstuvwxyz!', 12)).toBeNull();
  });
});

describe('CaptionTracker', () => {
  it('builds one segment from incrementally growing captions', () => {
    const { tracker, events, transcript } = setup();
    tracker.ingest([b('k1', 'Alice', 'Hello')], 0);
    tracker.ingest([b('k1', 'Alice', 'Hello every')], 100);
    tracker.ingest([b('k1', 'Alice', 'Hello everyone, welcome')], 200);
    expect(transcript()).toHaveLength(1);
    expect(transcript()[0]).toMatchObject({ id: 'seg-1', text: 'Hello everyone, welcome', status: 'interim', startedAt: 0, lastSpokenAt: 200 });
    expect(events.map((e) => e.change)).toEqual(['created', 'updated', 'updated']);
  });

  it('keeps revisions of recent words (original wording preserved)', () => {
    const { tracker, transcript } = setup();
    tracker.ingest([b('k1', 'Alice', 'I want to go to the')], 0);
    tracker.ingest([b('k1', 'Alice', 'I want to go to this store')], 100);
    expect(transcript()[0]?.text).toBe('I want to go to this store');
  });

  it('separates different speakers and keeps chronological order', () => {
    const { tracker, transcript } = setup();
    tracker.ingest([b('k1', 'Alice', 'Hi Bob')], 0);
    tracker.ingest([b('k1', 'Alice', 'Hi Bob'), b('k2', 'Bob', 'Hey Alice')], 500);
    tracker.ingest([b('k1', 'Alice', 'Hi Bob'), b('k2', 'Bob', 'Hey Alice'), b('k3', 'Carol', 'Morning all')], 900);
    expect(transcript().map((s) => [s.sequence, s.speaker, s.text])).toEqual([
      [1, 'Alice', 'Hi Bob'],
      [2, 'Bob', 'Hey Alice'],
      [3, 'Carol', 'Morning all'],
    ]);
  });

  it('finalizes a superseded block once stable, and the newest block after idle', () => {
    const { tracker, finals } = setup();
    tracker.ingest([b('k1', 'Alice', 'First point')], 0);
    tracker.ingest([b('k1', 'Alice', 'First point'), b('k2', 'Bob', 'Reply')], 1000);
    tracker.tick(1999);
    expect(finals()).toHaveLength(0);
    tracker.tick(2000); // k1 stable 2 s with a newer block below
    expect(finals().map((s) => s.text)).toEqual(['First point']);
    tracker.tick(5999);
    expect(finals()).toHaveLength(1);
    tracker.tick(6000); // k2 idle 5 s
    expect(finals().map((s) => s.text)).toEqual(['First point', 'Reply']);
    expect(finals()[1]?.finalizedAt).toBe(6000);
  });

  it('does not emit anything for identical snapshots (duplicate prevention)', () => {
    const { tracker, events } = setup();
    tracker.ingest([b('k1', 'Alice', 'Same text')], 0);
    tracker.ingest([b('k1', 'Alice', 'Same text')], 100);
    tracker.ingest([b('k1', 'Alice', '  Same   text ')], 200);
    expect(events).toHaveLength(1);
  });

  it('finalizes a block that disappears from the DOM after the grace period', () => {
    const { tracker, finals } = setup();
    tracker.ingest([b('k1', 'Alice', 'Going away soon')], 0);
    tracker.ingest([], 300);
    tracker.tick(1799);
    expect(finals()).toHaveLength(0);
    tracker.tick(1800);
    expect(finals().map((s) => s.text)).toEqual(['Going away soon']);
  });

  it('re-adopts a re-rendered block instead of duplicating it', () => {
    const { tracker, transcript } = setup();
    tracker.ingest([b('k1', 'Alice', 'A sentence that is being said')], 0);
    // Meet replaces the element: old key vanishes, new key shows the same text, then grows.
    tracker.ingest([b('k9', 'Alice', 'A sentence that is being said')], 100);
    tracker.ingest([b('k9', 'Alice', 'A sentence that is being said right now')], 200);
    tracker.tick(10_000);
    expect(transcript()).toHaveLength(1);
    expect(transcript()[0]).toMatchObject({ id: 'seg-1', text: 'A sentence that is being said right now', status: 'final' });
  });

  it('does not duplicate finalized text that is re-rendered later', () => {
    const { tracker, transcript } = setup();
    tracker.ingest([b('k1', 'Alice', 'This sentence was already finalized')], 0);
    tracker.tick(6000);
    tracker.ingest([], 6100);
    tracker.tick(9000); // orphan grace long gone
    tracker.ingest([b('k2', 'Alice', 'This sentence was already finalized')], 10_000);
    tracker.tick(20_000);
    expect(transcript()).toHaveLength(1);
  });

  it('still records short repeated phrases as new speech ("Yes." twice)', () => {
    const { tracker, transcript } = setup();
    tracker.ingest([b('k1', 'Alice', 'Yes.')], 0);
    tracker.tick(6000);
    tracker.ingest([], 6100);
    tracker.tick(9000);
    tracker.ingest([b('k2', 'Alice', 'Yes.')], 10_000);
    expect(transcript().map((s) => s.text)).toEqual(['Yes.', 'Yes.']);
  });

  it('amends the same segment when a finalized block keeps growing (no duplicate)', () => {
    const { tracker, transcript, events } = setup();
    tracker.ingest([b('k1', 'Alice', 'Let me think.')], 0);
    tracker.tick(5000);
    expect(transcript()[0]?.status).toBe('final');
    tracker.ingest([b('k1', 'Alice', 'Let me think. Okay, here is my answer')], 8000);
    tracker.tick(13_000);
    expect(transcript().map((s) => [s.id, s.text, s.status])).toEqual([
      ['seg-1', 'Let me think. Okay, here is my answer', 'final'],
    ]);
    const revisions = events.map((e) => e.segment.revision);
    expect(revisions).toEqual([...revisions].sort((x, y) => x - y));
  });

  // Regression from a real meeting: Meet corrected words mid-sentence after a pause.
  it('treats a mid-sentence correction as the same caption, not new speech', () => {
    const { tracker, transcript } = setup();
    const v1 = "Yeah, please go to the admin panel. There, usually a button. Click on it, and it's start person okay.";
    const v2 =
      "Yeah, please go to the admin panel. They're usually a button. Click on it, and it's start person. Okay. So, when you are ready, let me know.";
    tracker.ingest([b('k1', 'Amit Kumar', v1)], 0);
    tracker.tick(6000); // paused → finalized
    tracker.ingest([b('k1', 'Amit Kumar', v2)], 9000);
    tracker.tick(15_000);
    expect(transcript().map((s) => [s.speaker, s.text, s.status])).toEqual([['Amit Kumar', v2, 'final']]);
  });

  it('handles Hindi / Devanagari captions', () => {
    const { tracker, transcript } = setup();
    tracker.ingest([b('k1', 'You', 'हेलो ऐसे थोड़ी ना होता यार')], 0);
    tracker.ingest([b('k1', 'You', 'हेलो ऐसे थोड़ी ना होता यार मैं तो हूं थी हो आर यू आई एम फाइन')], 500);
    expect(transcript().map((s) => s.text)).toEqual(['हेलो ऐसे थोड़ी ना होता यार मैं तो हूं थी हो आर यू आई एम फाइन']);
  });

  it('carries text that slides out of a long block (long sentences)', () => {
    const { tracker, transcript } = setup();
    const s1 = 'The quarterly numbers look strong across every region.';
    const s2 = 'However we still need to talk about hiring plans';
    tracker.ingest([b('k1', 'Alice', s1)], 0);
    tracker.ingest([b('k1', 'Alice', `${s1} ${s2}`)], 500);
    tracker.ingest([b('k1', 'Alice', `${s2} for next year`)], 1000); // Meet dropped s1 from the DOM
    tracker.ingest([b('k1', 'Alice', `${s2} for next year and beyond.`)], 1500);
    expect(transcript()).toHaveLength(1);
    expect(transcript()[0]?.text).toBe(`${s1} ${s2} for next year and beyond.`);
  });

  it('finalizes and restarts when Meet resets a block in place', () => {
    const { tracker, transcript } = setup();
    tracker.ingest([b('k1', 'Alice', 'We should ship this on Friday afternoon')], 0);
    tracker.ingest([b('k1', 'Alice', 'Okay next topic')], 500);
    expect(transcript().map((s) => [s.text, s.status])).toEqual([
      ['We should ship this on Friday afternoon', 'final'],
      ['Okay next topic', 'interim'],
    ]);
  });

  it('flush() finalizes everything and a re-appearing element is not duplicated', () => {
    const { tracker, transcript } = setup();
    tracker.ingest([b('k1', 'Alice', 'Open segment'), b('k2', 'Bob', 'Another one')], 0);
    tracker.flush(100);
    expect(transcript().every((s) => s.status === 'final')).toBe(true);
    tracker.ingest([b('k1', 'Alice', 'Open segment'), b('k2', 'Bob', 'Another one')], 200);
    expect(transcript()).toHaveLength(2);
  });

  it('assigns unique ids and strictly increasing sequence numbers', () => {
    const { tracker, transcript } = setup();
    for (let i = 0; i < 50; i++) tracker.ingest([b(`k${i}`, i % 2 ? 'Bob' : 'Alice', `Utterance number ${i}`)], i * 1000);
    tracker.flush(60_000);
    const segs = transcript();
    expect(new Set(segs.map((s) => s.id)).size).toBe(50);
    expect(segs.map((s) => s.sequence)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('updates speaker name when Meet fills it in late', () => {
    const { tracker, transcript } = setup();
    tracker.ingest([b('k1', 'Unknown speaker', 'Hello')], 0);
    tracker.ingest([b('k1', 'Dana', 'Hello')], 100);
    expect(transcript()[0]?.speaker).toBe('Dana');
  });

  // Regression from a real meeting (2026-11-11): Meet rewrote half the sentence and
  // re-rendered the block with a NEW element (captions restarted).
  const V1 = "Hello, how are you you are doing good? Exact. America gave to me. I saw it up close to my family's name 15 hour Journey. I crossed 10 years difference in life expand.";
  const V2 = "Hello, how are you you are doing good? Exact. America gave to me. I saw it up close. I have to go 15 hours. I can go 15 minutes to Detroit or Pontiac and cross the same difference. It's why I became a doctor. Erica vaccinated me against diseases that killed an aunt's Uncle. I never got to me. Public Schools, University.";

  it('real-world rewrite in the same block stays one segment', () => {
    const { tracker, transcript } = setup();
    tracker.ingest([b('k1', 'You', V1)], 0);
    tracker.ingest([b('k1', 'You', V2)], 30_000);
    expect(transcript().map((s) => s.text)).toEqual([V2]);
  });

  it('real-world rewrite delivered in a re-rendered element (captions restarted) stays one segment', () => {
    const { tracker, transcript } = setup();
    tracker.ingest([b('k1', 'You', V1)], 0);
    tracker.flush(20_000); // captions switched off → everything finalized
    tracker.ingest([], 20_100); // region gone
    tracker.ingest([b('k7', 'You', V2)], 31_000); // back on: Meet redraws the (rewritten) block
    tracker.tick(40_000);
    expect(transcript().map((s) => [s.id, s.text, s.status])).toEqual([['seg-1', V2, 'final']]);
  });

  it('does not merge genuinely new speech that starts short, even if it later resembles an old line', () => {
    const { tracker, transcript } = setup();
    tracker.ingest([b('k1', 'You', 'Can you hear me now everyone')], 0);
    tracker.tick(6000);
    tracker.ingest([], 7000);
    tracker.ingest([b('k2', 'You', 'Can')], 20_000);
    tracker.ingest([b('k2', 'You', 'Can you hear me now everyone')], 21_000);
    expect(transcript()).toHaveLength(2);
  });
});
