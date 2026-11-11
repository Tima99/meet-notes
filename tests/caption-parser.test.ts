// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { MeetCaptionParser } from '../src/content/captions/caption-parser';
import { FakeMeet } from './fixtures/fake-meet';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

describe('MeetCaptionParser', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns null when captions are off', () => {
    expect(new MeetCaptionParser(undefined, silent).findRegion(document)).toBeNull();
  });

  it('parses speaker and text with the known selectors, skipping noise', () => {
    const meet = new FakeMeet(document);
    const region = meet.enableCaptions();
    meet.addBlock('Alice', 'Hello   there\n everyone');
    meet.addBlock('Bob', 'Hi!');
    const parser = new MeetCaptionParser(undefined, silent);
    expect(parser.findRegion(document)).toBe(region);
    expect(parser.parseBlocks(region).map(({ speaker, text }) => ({ speaker, text }))).toEqual([
      { speaker: 'Alice', text: 'Hello there everyone' },
      { speaker: 'Bob', text: 'Hi!' },
    ]);
  });

  it('falls back to structural parsing when class names change', () => {
    const meet = new FakeMeet(document, { obfuscated: true });
    const region = meet.enableCaptions();
    meet.addBlock('Alice', 'Structural works');
    meet.addBlock('Bob', 'Yes it does');
    const parsed = new MeetCaptionParser(undefined, silent).parseBlocks(region);
    expect(parsed.map(({ speaker, text }) => [speaker, text])).toEqual([
      ['Alice', 'Structural works'],
      ['Bob', 'Yes it does'],
    ]);
  });

  it('never parses the "Jump to bottom" control as a caption (structural mode)', () => {
    const meet = new FakeMeet(document, { obfuscated: true });
    const region = meet.enableCaptions();
    meet.addBlock('Amit Kumar', 'Hello');
    const parsed = new MeetCaptionParser(undefined, silent).parseBlocks(region);
    expect(parsed.map((p) => p.speaker)).toEqual(['Amit Kumar']);
    expect(parsed.some((p) => /arrow_downward|Jump to bottom/.test(p.speaker + p.text))).toBe(false);
  });

  it('inherits the previous speaker when a block has no name', () => {
    const meet = new FakeMeet(document);
    const region = meet.enableCaptions();
    meet.addBlock('Alice', 'First');
    const second = meet.addBlock('', 'Second');
    second.speakerEl.textContent = '';
    const parsed = new MeetCaptionParser(undefined, silent).parseBlocks(region);
    expect(parsed.map((p) => p.speaker)).toEqual(['Alice', 'Alice']);
  });

  it('ignores blocks with empty text', () => {
    const meet = new FakeMeet(document);
    const region = meet.enableCaptions();
    meet.addBlock('Alice', '   ');
    expect(new MeetCaptionParser(undefined, silent).parseBlocks(region)).toEqual([]);
  });
});
