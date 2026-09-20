import { splitSentences } from '../features/speech/sentenceSplit';

// The sentence-boundary scanner used by speakStream to enqueue utterances
// mid-stream. Its one hard rule: terminal punctuation must be followed by real
// whitespace, so decimals like "2.1" never split mid-number — a regression here
// would garble distances ("the 2" then "1 meter clearance") in a blind user's
// ear, silently.

describe('splitSentences', () => {
  it('keeps a decimal intact and splits only at a real sentence boundary', () => {
    const r = splitSentences('the 2.1 meter clearance is open. Go left.');
    expect(r.sentences).toEqual(['the 2.1 meter clearance is open. ']);
    expect(r.rest).toBe('Go left.');
  });

  it('does not split on "1.3 m" mid-sentence', () => {
    const r = splitSentences('about 1.3 m ahead');
    expect(r.sentences).toEqual([]);
    expect(r.rest).toBe('about 1.3 m ahead');
  });

  it('leaves a trailing fragment with no following whitespace in rest', () => {
    const r = splitSentences('Stop.');
    expect(r.sentences).toEqual([]);
    expect(r.rest).toBe('Stop.');
  });

  it('emits multiple sentences and keeps the final fragment', () => {
    const r = splitSentences('Hi! How are you? I am fine.');
    expect(r.sentences).toEqual(['Hi! ', 'How are you? ']);
    expect(r.rest).toBe('I am fine.');
  });

  it('treats a newline as a valid sentence boundary', () => {
    const r = splitSentences('Two sentences. Done.\n');
    expect(r.sentences).toEqual(['Two sentences. ', 'Done.\n']);
    expect(r.rest).toBe('');
  });

  it('handles an empty buffer', () => {
    const r = splitSentences('');
    expect(r.sentences).toEqual([]);
    expect(r.rest).toBe('');
  });

  it('accumulates across calls the way push() does', () => {
    // Simulate streaming: feed deltas, splitting the growing buffer each time.
    let buffer = '';
    const emitted: string[] = [];
    for (const delta of ['the 2.', '1 meter clearance is', ' open. Go ', 'left.']) {
      buffer += delta;
      const r = splitSentences(buffer);
      buffer = r.rest;
      emitted.push(...r.sentences);
    }
    expect(emitted).toEqual(['the 2.1 meter clearance is open. ']);
    expect(buffer).toBe('Go left.');
  });
});
