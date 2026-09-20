import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { SCENE_URL } from './backendConfig';
import { CLOUD_AI_ENABLED } from './featureFlags';

// ElevenLabs-backed natural voice, streamed sentence-by-sentence through the
// proxy's GET /tts endpoint. Availability is probed once from /health; every
// failure falls back to the caller's on-device TTS path so speech never dies.

const BASE_URL = SCENE_URL?.replace('/describe-scene', '');
const APP_SECRET = process.env.EXPO_PUBLIC_SCENE_APP_SECRET;

let available: boolean | null = null;
let probing: Promise<boolean> | null = null;

export function naturalVoiceAvailable(): Promise<boolean> {
  if (!CLOUD_AI_ENABLED) return Promise.resolve(false);
  if (available !== null) return Promise.resolve(available);
  probing ??= (async () => {
    try {
      if (!BASE_URL) return (available = false);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(`${BASE_URL}/health`, { signal: controller.signal });
      clearTimeout(timer);
      const { tts } = (await response.json()) as { tts?: boolean };
      available = Boolean(tts);
    } catch {
      available = false;
    }
    console.log(`[naturalVoice] ElevenLabs available: ${available}`);
    return available;
  })();
  return probing;
}

function ttsUrl(text: string): string {
  const params = new URLSearchParams({ text });
  if (APP_SECRET) params.set('secret', APP_SECRET);
  return `${BASE_URL}/tts?${params.toString()}`;
}

// Sequential playback queue: sentences play in order, each awaited to
// completion. stopNatural() aborts the whole queue (critical alerts win).
let queue: Promise<void> = Promise.resolve();
let activePlayer: AudioPlayer | null = null;
let generation = 0;

function playOne(text: string, myGeneration: number): Promise<void> {
  return new Promise((resolve) => {
    if (myGeneration !== generation) return resolve();
    let player: AudioPlayer;
    try {
      player = createAudioPlayer({ uri: ttsUrl(text) });
    } catch {
      return resolve();
    }
    activePlayer = player;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      try {
        subscription.remove();
        player.remove();
      } catch {
        // already released
      }
      if (activePlayer === player) activePlayer = null;
      resolve();
    };
    // A sentence should never take >30s; guards against a hung stream.
    const watchdog = setTimeout(finish, 30_000);
    const subscription = player.addListener('playbackStatusUpdate', (status) => {
      if (status.didJustFinish) finish();
    });
    try {
      player.play();
    } catch {
      finish();
    }
  });
}

// Speak one sentence with ElevenLabs. Returns a promise that resolves when
// playback of this sentence completes. Throws never — callers treat a resolved
// promise as "handled" and should pre-check naturalVoiceAvailable().
export function naturalSpeak(text: string): Promise<void> {
  const sentence = text.trim();
  if (!sentence) return Promise.resolve();
  const myGeneration = generation;
  queue = queue.then(() => playOne(sentence, myGeneration));
  return queue;
}

export function stopNatural(): void {
  generation += 1; // invalidate everything queued
  queue = Promise.resolve();
  const player = activePlayer;
  activePlayer = null;
  if (player) {
    try {
      player.pause();
      player.remove();
    } catch {
      // already released
    }
  }
}
