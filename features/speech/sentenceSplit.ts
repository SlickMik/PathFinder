// Pure streaming-sentence boundary scanner. Kept in its own module with no
// native (expo-audio / expo-speech) imports so it is unit-testable under jest
// without dragging in a native module that does not resolve outside a device.

export type SentenceSplit = { sentences: string[]; rest: string };

// Splits a streaming text buffer into complete sentences plus the leftover
// tail. A sentence ends only at terminal punctuation (. ! ?) FOLLOWED by real
// whitespace, so decimals like "2.1" and "1.3 m" never split mid-number —
// otherwise TTS would say "the 2" then "1 meter clearance" as separate
// utterances, garbling distances in a blind user's ear. Any trailing fragment
// without following whitespace is returned as `rest` for the caller to flush
// once the stream ends.
export function splitSentences(buffer: string): SentenceSplit {
  const sentences: string[] = [];
  let rest = buffer;
  let match: RegExpMatchArray | null;
  while ((match = rest.match(/^[\s\S]*?[.!?]+\s+/))) {
    sentences.push(match[0]);
    rest = rest.slice(match[0].length);
  }
  return { sentences, rest };
}
