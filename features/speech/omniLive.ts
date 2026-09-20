import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { readAsStringAsync } from 'expo-file-system/legacy';
import { ExpoLidarVision } from '../../modules/expo-lidar-vision';
import { buildLidarPayload, getCompanionHistory, recordCompanionTurn } from './companion';
import type { AlertState, NavigationGuidance, ObstacleSnapshot } from '../scanning/types';

// OMNI Live (Huawei HTN track): ONE Qwen Omni call carries all three
// modalities of a companion turn — the user's raw speech (audio), a fresh
// camera frame (vision), and LiDAR/journey context (language) — and returns
// both a transcript and the model's own natural spoken reply.
//
// This path replaces three sequential calls (on-device STT → Baseten reply →
// TTS) with a single round trip. It is strictly optional: availability is
// probed once from /health, and every failure returns null so callers fall
// back to the existing chain. Deterministic LiDAR alerts never touch this.

const SCENE_URL = process.env.EXPO_PUBLIC_SCENE_DESCRIBE_URL;
const BASE_URL = SCENE_URL?.replace('/describe-scene', '');
const OMNI_URL = BASE_URL ? `${BASE_URL}/omni` : undefined;
const APP_SECRET = process.env.EXPO_PUBLIC_SCENE_APP_SECRET;
// One buffered multimodal round trip (audio understanding + speech synthesis).
const REQUEST_TIMEOUT_MS = 40_000;

let available: boolean | null = null;
let probing: Promise<boolean> | null = null;

export function omniAvailable(): Promise<boolean> {
  if (available !== null) return Promise.resolve(available);
  probing ??= (async () => {
    try {
      if (!BASE_URL) return (available = false);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(`${BASE_URL}/health`, { signal: controller.signal });
      clearTimeout(timer);
      const { omni } = (await response.json()) as { omni?: boolean };
      available = Boolean(omni);
    } catch {
      available = false;
    }
    console.log(`[omni] OMNI Live available: ${available}`);
    return available;
  })();
  return probing;
}

export type OmniOptions = {
  // On-device transcript of the same utterance — used only to label the user
  // turn in the shared conversation history (OMNI hears the audio itself).
  transcript?: string;
  snapshot?: ObstacleSnapshot | null;
  alert?: AlertState | null;
  guidance?: NavigationGuidance | null;
  events?: string[];
  withFrame?: boolean;
};

export type OmniResult = { reply: string; audioUrl: string | null };

// Sends one OMNI Live turn from the recognizer's persisted audio file.
// Returns null when unconfigured or failed — callers fall back to the
// transcript → Baseten → on-device TTS chain, so speech never dies.
export async function omniAskFromUri(
  audioUri: string,
  options: OmniOptions = {},
): Promise<OmniResult | null> {
  if (!OMNI_URL || !(await omniAvailable())) return null;
  const {
    transcript,
    snapshot = null,
    alert = null,
    guidance = null,
    events = [],
    withFrame = false,
  } = options;
  try {
    const audioBase64 = await readAsStringAsync(audioUri, { encoding: 'base64' });
    const extension = audioUri.split('.').pop()?.toLowerCase() ?? 'wav';
    const audioMime =
      extension === 'wav' ? 'audio/wav' : extension === 'caf' ? 'audio/x-caf' : 'audio/m4a';
    const frame = withFrame ? await ExpoLidarVision.captureFrame(512, 0.5) : null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      console.log(`[omni] POST ${OMNI_URL} (frame=${Boolean(frame)}, audio=${extension})`);
      const response = await fetch(OMNI_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(APP_SECRET ? { 'x-app-secret': APP_SECRET } : {}),
        },
        body: JSON.stringify({
          audioBase64,
          audioMime,
          history: getCompanionHistory(),
          events: events.slice(-6),
          lidar: buildLidarPayload(snapshot, alert, guidance),
          ...(frame ? { imageBase64: frame.base64, mimeType: 'image/jpeg' } : {}),
        }),
      });
      if (!response.ok) throw new Error(`OMNI request failed (${response.status}).`);
      const { reply, audioId } = (await response.json()) as {
        reply?: string;
        audioId?: string | null;
      };
      if (!reply) throw new Error('Incomplete OMNI response.');
      recordCompanionTurn(transcript?.trim() || '(spoken message)', reply);
      return { reply, audioUrl: audioId ? omniAudioUrl(audioId) : null };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.warn('[omni] turn failed, falling back:', error);
    return null;
  }
}

function omniAudioUrl(audioId: string): string {
  const params = new URLSearchParams({ id: audioId });
  if (APP_SECRET) params.set('secret', APP_SECRET);
  return `${BASE_URL}/omni-audio?${params.toString()}`;
}

// --- playback of OMNI's spoken reply ----------------------------------------
// Local safety always wins: the guard is polled while playing and the audio
// stops the moment it returns false (e.g. a critical obstacle alert fired).

let activePlayer: AudioPlayer | null = null;
let generation = 0;

export function stopOmniAudio(): void {
  generation += 1;
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

export function playOmniAudio(url: string, guard?: () => boolean): Promise<void> {
  stopOmniAudio();
  const myGeneration = generation;
  return new Promise((resolve) => {
    if (guard && !guard()) return resolve();
    let player: AudioPlayer;
    try {
      player = createAudioPlayer({ uri: url });
    } catch {
      return resolve();
    }
    activePlayer = player;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearInterval(guardTimer);
      try {
        subscription.remove();
        player.remove();
      } catch {
        // already released
      }
      if (activePlayer === player) activePlayer = null;
      resolve();
    };
    // A reply should never take >60s; guards against a hung stream.
    const watchdog = setTimeout(finish, 60_000);
    const guardTimer = setInterval(() => {
      if (myGeneration !== generation || (guard && !guard())) {
        try {
          player.pause();
        } catch {
          // already released
        }
        finish();
      }
    }, 250);
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
