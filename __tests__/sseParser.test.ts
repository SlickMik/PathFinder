import { parseSseChunk } from '../features/speech/sceneDescriber';

// Drives the pure SSE offset-slicer the same way streamSSE does: feed the
// parser successive `responseText` snapshots (growing as bytes arrive) and
// thread nextOffset forward. This is the on-device XHR path that cannot be
// exercised here against a real network, so we cover the slicing edge cases
// directly — mid-event splits, multi-event chunks, [DONE], and error events.

describe('parseSseChunk', () => {
  it('returns nothing when no newline has arrived yet', () => {
    const r = parseSseChunk('data: {"delta":"hel', 0);
    expect(r.deltas).toEqual([]);
    expect(r.nextOffset).toBe(0);
    expect(r.done).toBe(false);
  });

  it('emits deltas from multiple complete events in one chunk', () => {
    const text = 'data: {"delta":"Hello"}\n\ndata: {"delta":" world"}\n\n';
    const r = parseSseChunk(text, 0);
    expect(r.deltas).toEqual(['Hello', ' world']);
    expect(r.nextOffset).toBe(text.length);
  });

  it('handles a data event split across two chunks', () => {
    // First chunk: the line is incomplete (no newline) — must NOT parse it.
    const part1 = 'data: {"delta":"Half';
    let r = parseSseChunk(part1, 0);
    expect(r.deltas).toEqual([]);
    expect(r.nextOffset).toBe(0);
    // Second chunk: the rest of the line plus its newline. Re-feed the full
    // accumulated text and the carried offset.
    const full = 'data: {"delta":"Half a sentence"}\n\n';
    r = parseSseChunk(full, 0);
    expect(r.deltas).toEqual(['Half a sentence']);
    expect(r.nextOffset).toBe(full.length);
  });

  it('carries a trailing partial line via nextOffset', () => {
    // One complete event then the start of a second, incomplete event.
    const text = 'data: {"delta":"one"}\n\ndata: {"delta":"tw';
    const r = parseSseChunk(text, 0);
    expect(r.deltas).toEqual(['one']);
    // nextOffset points just past the last newline, leaving the incomplete
    // second event unconsumed so it is re-examined once more bytes arrive.
    expect(r.nextOffset).toBe('data: {"delta":"one"}\n\n'.length);
    expect(text.slice(r.nextOffset)).toBe('data: {"delta":"tw');
  });

  it('ignores non-data lines, blank lines, and SSE comments', () => {
    const text = ': a comment\n\ndata: {"delta":"ok"}\n\n: another\n\n';
    const r = parseSseChunk(text, 0);
    expect(r.deltas).toEqual(['ok']);
  });

  it('flags [DONE] without emitting a delta', () => {
    const text = 'data: {"delta":"bye"}\n\ndata: [DONE]\n\n';
    const r = parseSseChunk(text, 0);
    expect(r.deltas).toEqual(['bye']);
    expect(r.done).toBe(true);
  });

  it('surfaces a server-side error event and keeps streaming deltas after it', () => {
    const text =
      'data: {"delta":"partial"}\n\ndata: {"error":"upstream blew up"}\n\ndata: {"delta":"more"}\n\n';
    const r = parseSseChunk(text, 0);
    expect(r.deltas).toEqual(['partial', 'more']);
    expect(r.error).toBe('upstream blew up');
  });

  it('skips malformed JSON lines without throwing', () => {
    const text = 'data: {not json\n\ndata: {"delta":"good"}\n\n';
    const r = parseSseChunk(text, 0);
    expect(r.deltas).toEqual(['good']);
    expect(r.error).toBeNull();
  });

  it('threads an arbitrary start offset (mid-stream)', () => {
    const text = 'garbage-data: {"delta":"one"}\n\ndata: {"delta":"two"}\n\n';
    // Start after the first event has already been consumed.
    const start = 'garbage-data: {"delta":"one"}\n\n'.length;
    const r = parseSseChunk(text, start);
    expect(r.deltas).toEqual(['two']);
    expect(r.nextOffset).toBe(text.length);
  });
});
