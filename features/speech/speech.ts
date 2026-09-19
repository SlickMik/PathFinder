import { setAudioModeAsync } from 'expo-audio';
import * as Speech from 'expo-speech';

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

export async function speak(text: string, critical = false): Promise<void> {
  await ensureAudioMode();
  if (preferredVoice === undefined) preferredVoice = await resolveVoice();
  // Critical alerts cut off whatever is being read; others queue behind it.
  if (critical) await Speech.stop();
  Speech.speak(text, {
    rate: critical ? 1.05 : 0.98,
    pitch: 1.0,
    language: 'en-US',
    ...(preferredVoice ? { voice: preferredVoice } : {}),
  });
}

export function stopSpeaking(): Promise<void> {
  return Speech.stop();
}
