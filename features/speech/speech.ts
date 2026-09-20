import { setAudioModeAsync } from 'expo-audio';
import * as Speech from 'expo-speech';
import { naturalSpeak, naturalVoiceAvailable, stopNatural } from './naturalVoice';
import { splitSentences } from './sentenceSplit';

let audioReady: Promise<void> | null = null;
// undefined = not resolved yet; null = resolved, use system default.
let preferredVoice: string | null | undefined;

// AccessibilityInfo.announceForAccessibility only speaks when VoiceOver is on.
// Speaking through AVSpeechSynthesizer works regardless, but only if the audio
// session plays in silent mode and can duck other audio.
function ensureAudioMode(): Promise<void> {
  audioReady ??= setAudioModeAsync({
    playsInSilentMode: true,
    interruptionMode: 'duckOthers',
    allowsRecording: false,
    shouldPlayInBackground: false,
    // A playback-only session uses the iPhone's loudspeaker instead of the
    // receiver. Keep this explicit so adding voice input later cannot silently
    // move navigation instructions to the earpiece.
    shouldRouteThroughEarpiece: false,
  }).catch(() => {
    audioReady = null;
  });
  return audioReady;
}

// Speech recognition flips the session into record mode. Call this after it
// finishes so replies come out of the loudspeaker again.
export function reapplyAudioMode(): Promise<void> {
  audioReady = null;
  return ensureAudioMode();
}

// Prefer the most natural voice installed on the device. iOS ships compact
// (robotic) voices by default; premium/enhanced ones sound human. Users can
// add them in Settings > Accessibility > Spoken Content > Voices > English.
async function resolveVoice(): Promise<string | null> {
  try {
    const voices = await Speech.getAvailableVoicesAsync();
    const english = voices.filter((voice) => voice.language?.startsWith('en'));
    const pick =
      english.find((voice) => voice.identifier?.includes('premium')) ??
      english.find((voice) => voice.identifier?.includes('enhanced')) ??
      null;
    console.log(`[speech] voice: ${pick?.identifier ?? 'system default (compact)'}`);
    return pick?.identifier ?? null;
  } catch {
    return null;
  }
}

// Resolves when the utterance finishes (or is stopped) — lets callers wait
// for speech to end before reopening the microphone.
export function speak(text: string, critical = false): Promise<void> {
  return new Promise((resolve) => {
    void (async () => {
      await ensureAudioMode();
      // Non-critical speech prefers the ElevenLabs natural voice when the
      // backend has it configured. Critical alerts ALWAYS use on-device TTS:
      // a safety warning must never wait on a network round-trip.
      if (!critical && (await naturalVoiceAvailable())) {
        await naturalSpeak(text);
        resolve();
        return;
      }
      if (preferredVoice === undefined) preferredVoice = await resolveVoice();
      // Critical alerts cut off whatever is being read; others queue behind it.
      if (critical) await Speech.stop();
      Speech.speak(text, {
        rate: critical ? 1.05 : 0.98,
        pitch: 1.0,
        language: 'en-US',
        ...(preferredVoice ? { voice: preferredVoice } : {}),
        onDone: () => resolve(),
        onStopped: () => resolve(),
        onError: () => resolve(),
      });
    })();
  });
}

// Voice lookup is stable for the process lifetime, so memoize only that. The
// audio session is deliberately NOT memoized here: useVoiceInput's 'end'
// handler calls reapplyAudioMode() (which nulls `audioReady`) and then
// synchronously fires the transcript callback into askCompanion. Each streamed
// turn must therefore await ensureAudioMode() fresh, or the first sentence can
// be enqueued while the session is still in record mode — quiet or routed to
// the earpiece. The old speak() path awaited ensureAudioMode() every call; we
// preserve that invariant per stream.
let voiceResolved: Promise<void> | null = null;
function ensureVoiceResolved(): Promise<void> {
  voiceResolved ??= (async () => {
    if (preferredVoice === undefined) preferredVoice = await resolveVoice();
  })();
  return voiceResolved;
}

export type SpeakStream = {
  // Feed token deltas as they arrive; completed sentences are enqueued on the
  // synthesizer immediately. Text without terminal punctuation is buffered.
  push(text: string): void;
  // Call once the stream is exhausted; flushes any trailing text and resolves
  // when every enqueued utterance has finished (or been stopped).
  done(): Promise<void>;
};

// Incremental speech for streamed replies. expo-speech (AVSpeechSynthesizer)
// queues utterances natively, so each sentence is spoken the instant it is
// complete — the pedestrian hears the first sentence ~1s after asking instead
// of waiting for the whole reply to generate. guard() is consulted before each
// enqueue: returning false drops that sentence so a streamed reply yields to a
// higher-priority local alert instead of resuming over it.
export function speakStream(guard?: () => boolean): SpeakStream {
  let buffer = '';
  let finished = false;
  let pending = 0;
  let ready = false;
  const waiting: string[] = [];
  const { promise: donePromise, resolve: resolveDone } = Promise.withResolvers<void>();

  const checkEnd = () => {
    if (finished && ready && waiting.length === 0 && pending <= 0) resolveDone();
  };

  let useNatural = false;

  const enqueue = (text: string) => {
    const sentence = text.trim();
    if (!sentence) return;
    if (guard && !guard()) return;
    pending += 1;
    if (useNatural) {
      // ElevenLabs queue keeps sentence order; resolves when playback ends.
      void naturalSpeak(sentence).then(() => {
        pending -= 1;
        checkEnd();
      });
      return;
    }
    Speech.speak(sentence, {
      rate: 0.98,
      pitch: 1.0,
      language: 'en-US',
      ...(preferredVoice ? { voice: preferredVoice } : {}),
      onDone: () => {
        pending -= 1;
        checkEnd();
      },
      onStopped: () => {
        pending -= 1;
        checkEnd();
      },
      onError: () => {
        pending -= 1;
        checkEnd();
      },
    });
  };

  void (async () => {
    // Await the (possibly just-reapplied) audio session fresh each stream,
    // then the memoized voice lookup.
    await ensureAudioMode();
    await ensureVoiceResolved();
    useNatural = await naturalVoiceAvailable();
    ready = true;
    for (const s of waiting) enqueue(s);
    waiting.length = 0;
    checkEnd();
  })();

  return {
    push(text) {
      if (finished) return;
      buffer += text;
      const { sentences, rest } = splitSentences(buffer);
      buffer = rest;
      for (const sentence of sentences) {
        if (!ready) waiting.push(sentence);
        else enqueue(sentence);
      }
    },
    done() {
      finished = true;
      const rest = buffer;
      buffer = '';
      if (rest.trim()) {
        if (!ready) waiting.push(rest);
        else enqueue(rest);
      }
      checkEnd();
      return donePromise;
    },
  };
}

export function stopSpeaking(): Promise<void> {
  stopNatural();
  return Speech.stop();
}
