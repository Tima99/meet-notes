// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CaptionObserver, type CaptionObserverEvent } from '../src/content/captions/caption-observer';
import { MeetCaptionParser } from '../src/content/captions/caption-parser';
import { FakeMeet, settle } from './fixtures/fake-meet';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

describe('CaptionObserver', () => {
  let observer: CaptionObserver;
  let events: CaptionObserverEvent[];
  let meet: FakeMeet;

  beforeEach(() => {
    document.body.innerHTML = '';
    events = [];
    meet = new FakeMeet(document);
    observer = new CaptionObserver(
      { document, parser: new MeetCaptionParser(undefined, silent), clock: { now: () => Date.now() }, logger: silent },
      { searchDelayMs: 5, revalidateDelayMs: 5 },
    );
  });
  afterEach(() => observer.stop());

  const snapshots = () => events.filter((e) => e.kind === 'snapshot').map((e) => (e.kind === 'snapshot' ? e.blocks.map((b) => `${b.speaker}: ${b.text}`) : []));

  it('stays quiet while captions are off, then reports region-found', async () => {
    observer.start((e) => events.push(e));
    expect(events).toEqual([]);
    expect(observer.hasRegion).toBe(false);
    meet.enableCaptions();
    meet.addBlock('Alice', 'Hello');
    await settle(30);
    expect(events.map((e) => e.kind)).toContain('region-found');
    expect(snapshots().at(-1)).toEqual(['Alice: Hello']);
  });

  it('emits a snapshot for every characterData change, with stable block keys', async () => {
    meet.enableCaptions();
    const block = meet.addBlock('Alice', 'Hel');
    observer.start((e) => events.push(e));
    meet.setText(block, 'Hello');
    await settle();
    meet.setText(block, 'Hello world');
    await settle();
    expect(snapshots()).toEqual([['Alice: Hel'], ['Alice: Hello'], ['Alice: Hello world']]);
    const keys = events.flatMap((e) => (e.kind === 'snapshot' ? e.blocks.map((b) => b.key) : []));
    expect(new Set(keys).size).toBe(1);
  });

  it('suppresses snapshots when nothing caption-related changed', async () => {
    meet.enableCaptions();
    const block = meet.addBlock('Alice', 'Static');
    observer.start((e) => events.push(e));
    block.element.setAttribute('data-x', '1');
    block.textEl.append(document.createComment('noise'));
    await settle();
    expect(snapshots()).toHaveLength(1);
  });

  it('reports region-lost when captions are disabled and recovers when re-enabled', async () => {
    meet.enableCaptions();
    meet.addBlock('Alice', 'Before');
    observer.start((e) => events.push(e));
    meet.disableCaptions();
    await settle(30);
    expect(events.at(-1)?.kind).toBe('region-lost');
    meet.enableCaptions();
    meet.addBlock('Bob', 'After');
    await settle(30);
    expect(snapshots().at(-1)).toEqual(['Bob: After']);
  });

  it('stops emitting after stop()', async () => {
    meet.enableCaptions();
    const block = meet.addBlock('Alice', 'One');
    observer.start((e) => events.push(e));
    observer.stop();
    const count = events.length;
    meet.setText(block, 'One two');
    await settle(30);
    expect(events).toHaveLength(count);
  });
});
