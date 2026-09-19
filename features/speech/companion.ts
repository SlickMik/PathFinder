import { ExpoLidarVision } from '../../modules/expo-lidar-vision';
import { compactLidarContext } from './sceneDescriber';
import type { ObstacleSnapshot } from '../scanning/types';

// Companion mode: turns the journey into a running conversation with a warm
// voice ("Path") instead of terse announcements. Deterministic obstacle
// alerts are NOT routed through this — they stay local and instant.

const SCENE_URL = process.env.EXPO_PUBLIC_SCENE_DESCRIBE_URL;
const COMPANION_URL =
  process.env.EXPO_PUBLIC_COMPANION_URL ?? SCENE_URL?.replace('/describe-scene', '/companion');
const APP_SECRET = process.env.EXPO_PUBLIC_SCENE_APP_SECRET;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TURNS = 16;

type Turn = { role: 'user' | 'assistant'; content: string };

const history: Turn[] = [];
let inFlight: Promise<string> | null = null;

export function resetCompanion(): void {
  history.length = 0;
}

type CompanionOptions = {
  snapshot?: ObstacleSnapshot | null;
  withFrame?: boolean;
};

// Sends one conversational turn (optionally with a fresh camera frame) and
// returns the spoken-style reply. Coalesces onto any turn already in flight.
export function companionSay(text: string, options: CompanionOptions = {}): Promise<string> {
  inFlight ??= requestReply(text, options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function requestReply(
  text: string,
  { snapshot = null, withFrame = false }: CompanionOptions,
): Promise<string> {
  if (!COMPANION_URL) throw new Error('Companion backend is not configured.');
  console.log(`[companion] POST ${COMPANION_URL} (frame=${withFrame})`);

  const frame = withFrame ? await ExpoLidarVision.captureFrame(768, 0.6) : null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(COMPANION_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(APP_SECRET ? { 'x-app-secret': APP_SECRET } : {}),
      },
      body: JSON.stringify({
        text,
        history,
        lidar: compactLidarContext(snapshot),
        ...(frame ? { imageBase64: frame.base64, mimeType: 'image/jpeg' } : {}),
      }),
    });
    if (!response.ok) throw new Error(`Companion request failed (${response.status}).`);
    const { reply } = (await response.json()) as { reply?: string };
    if (!reply) throw new Error('No reply returned.');

    history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    while (history.length > MAX_TURNS) history.splice(0, 2);
    return reply;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Companion timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
