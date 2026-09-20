import { ExpoLidarVision } from '../../modules/expo-lidar-vision';
import { compactLidarContext, streamSSE } from './sceneDescriber';
import type { AlertState, NavigationGuidance, ObstacleSnapshot } from '../scanning/types';

// Companion mode: turns the journey into a running conversation with a warm
// voice ("Path") instead of terse announcements. Deterministic obstacle
// alerts are NOT routed through this — they stay local and instant.

const SCENE_URL = process.env.EXPO_PUBLIC_SCENE_DESCRIBE_URL;
const COMPANION_URL =
  process.env.EXPO_PUBLIC_COMPANION_URL ?? SCENE_URL?.replace('/describe-scene', '/companion');
const APP_SECRET = process.env.EXPO_PUBLIC_SCENE_APP_SECRET;
const REQUEST_TIMEOUT_MS = 15_000;
// Streamed replies get a larger no-delta budget than a buffered round-trip: a
// cold vision model can take ~13s to its first token, and the stall timer only
// resets once tokens flow.
const STREAM_TIMEOUT_MS = 25_000;
const MAX_TURNS = 16;

type Turn = { role: 'user' | 'assistant'; content: string };

const history: Turn[] = [];
let inFlight: Promise<string> | null = null;

export function resetCompanion(): void {
  history.length = 0;
}

// The conversation is shared across reply brains: a turn answered by OMNI
// (omniLive.ts) is context for the next Baseten turn and vice versa.
export function getCompanionHistory(): Turn[] {
  return [...history];
}

export function recordCompanionTurn(user: string, reply: string): void {
  history.push({ role: 'user', content: user }, { role: 'assistant', content: reply });
  while (history.length > MAX_TURNS) history.splice(0, 2);
}

// Compact LiDAR context per PLAN.md §8 — sector distances, alert state, and
// route guidance only; never the raw depth map. Shared with omniLive.ts.
export function buildLidarPayload(
  snapshot: ObstacleSnapshot | null,
  alert: AlertState | null,
  guidance: NavigationGuidance | null,
) {
  return {
    ...(compactLidarContext(snapshot) ?? {}),
    alert: alert ? { risk: alert.risk, direction: alert.direction } : null,
    guidance:
      guidance && guidance.instruction !== 'hold'
        ? {
            instruction: guidance.instruction,
            clearanceM: guidance.clearanceM,
            openingWidthM: guidance.openingWidthM,
            confidence: guidance.confidence,
            source: guidance.source,
          }
        : null,
  };
}

type CompanionOptions = {
  snapshot?: ObstacleSnapshot | null;
  alert?: AlertState | null;
  guidance?: NavigationGuidance | null;
  events?: string[];
  withFrame?: boolean;
  // When set, the reply is streamed token-by-token: each delta is passed to
  // onDelta the moment it arrives so on-device TTS can start speaking the
  // first sentence before the model finishes the rest.
  onDelta?: (delta: string) => void;
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
  {
    snapshot = null,
    alert = null,
    guidance = null,
    events = [],
    withFrame = false,
    onDelta,
  }: CompanionOptions,
): Promise<string> {
  if (!COMPANION_URL) throw new Error('Companion backend is not configured.');
  console.log(`[companion] POST ${COMPANION_URL} (frame=${withFrame}, stream=${!!onDelta})`);

  // 512px halves the vision-token count vs 768px — fastest useful size.
  const frame = withFrame ? await ExpoLidarVision.captureFrame(512, 0.5) : null;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(APP_SECRET ? { 'x-app-secret': APP_SECRET } : {}),
  };
  const lidar = buildLidarPayload(snapshot, alert, guidance);
  const body = {
    text,
    history,
    events: events.slice(-6),
    lidar,
    ...(frame ? { imageBase64: frame.base64, mimeType: 'image/jpeg' } : {}),
    // Streaming: ask the proxy to forward tokens as SSE so on-device TTS can
    // begin at the first sentence. Without onDelta we keep the simple JSON
    // round-trip (one buffered response).
    ...(onDelta ? { stream: true } : {}),
  };

  try {
    const reply = onDelta
      ? await streamSSE(COMPANION_URL, headers, body, { onDelta, timeoutMs: STREAM_TIMEOUT_MS })
      : await postReply(COMPANION_URL, headers, body, REQUEST_TIMEOUT_MS);
    if (!reply) throw new Error('No reply returned.');

    history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    while (history.length > MAX_TURNS) history.splice(0, 2);
    return reply;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Companion timed out.');
    }
    throw error;
  }
}

async function postReply(
  url: string,
  headers: Record<string, string>,
  body: object,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Companion request failed (${response.status}).`);
    const { reply } = (await response.json()) as { reply?: string };
    return reply ?? '';
  } finally {
    clearTimeout(timeout);
  }
}
