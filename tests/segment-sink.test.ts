import { describe, expect, it } from 'vitest';
import { SegmentSink } from '../src/content/segment-sink';
import type { TranscriptSegment } from '../src/shared/types';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };
const seg = (id: string, text: string, status: 'interim' | 'final' = 'interim', sequence = 1): TranscriptSegment => ({
  id, meetingId: 'm', sequence, speaker: 'A', text, startedAt: 0, lastSpokenAt: 0, finalizedAt: status === 'final' ? 1 : null, revision: 1, status,
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SegmentSink', () => {
  it('coalesces interim updates to the latest version per segment', async () => {
    const sent: (readonly TranscriptSegment[])[] = [];
    const sink = new SegmentSink(async (b) => void sent.push(b), { interimDelayMs: 20 }, silent);
    sink.push(seg('a', 'He'));
    sink.push(seg('a', 'Hel'));
    sink.push(seg('a', 'Hello'));
    await wait(40);
    expect(sent).toEqual([[seg('a', 'Hello')]]);
  });

  it('sends final segments immediately', async () => {
    const sent: (readonly TranscriptSegment[])[] = [];
    const sink = new SegmentSink(async (b) => void sent.push(b), { interimDelayMs: 10_000 }, silent);
    sink.push(seg('a', 'Done', 'final'));
    await wait(5);
    expect(sent).toHaveLength(1);
  });

  it('retries failed sends and lets newer versions win', async () => {
    let fails = 1;
    const sent: (readonly TranscriptSegment[])[] = [];
    const sink = new SegmentSink(
      async (b) => {
        if (fails-- > 0) throw new Error('worker asleep');
        sent.push(b);
      },
      { interimDelayMs: 1, retryDelayMs: 20 },
      silent,
    );
    sink.push(seg('a', 'v1'));
    await wait(5);
    sink.push(seg('a', 'v2', 'final'));
    await wait(40);
    expect(sent.flat().map((s) => s.text)).toEqual(['v2']);
    expect(sink.pendingCount).toBe(0);
  });
});
