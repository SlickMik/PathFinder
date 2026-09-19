import { setAudioModeAsync } from 'expo-audio';
import * as Speech from 'expo-speech';

let audioReady: Promise<void> | null = null;

// AccessibilityInfo.announceForAccessibility only speaks when VoiceOver is on.
// Speaking through AVSpeechSynthesizer works regardless, but only if the audio
// session plays in silent mode and can duck other audio.
function ensureAudioMode(): Promise<void> {
  audioReady ??= setAudioModeAsync({
    playsInSilentMode: true,
    interruptionMode: 'duckOthers',
    shouldPlayInBackground: false,
  }).catch(() => {
    audioReady = null;
  });
  return audioReady;
}

export async function speak(text: string, critical = false): Promise<void> {
  await ensureAudioMode();
  // Critical alerts cut off whatever is being read; others queue behind it.
  if (critical) await Speech.stop();
  Speech.speak(text, { rate: critical ? 1.1 : 1.0, language: 'en-US' });
}

export function stopSpeaking(): Promise<void> {
  return Speech.stop();
}
