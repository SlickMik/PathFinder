import { ExpoLidarVision } from '../../modules/expo-lidar-vision';
import type { ObstacleSnapshot, SectorReading } from '../scanning/types';

const SCENE_URL = process.env.EXPO_PUBLIC_SCENE_DESCRIBE_URL;
const APP_SECRET = process.env.EXPO_PUBLIC_SCENE_APP_SECRET;
const REQUEST_TIMEOUT_MS = 15_000;
// Streamed replies get a larger no-delta budget: a cold vision model can take
// ~13s to its first token, and the stall timer only resets once tokens flow,
// so the pre-first-token window needs more headroom than a buffered round-trip.
const STREAM_TIMEOUT_MS = 25_000;

// Compact LiDAR context per PLAN.md §8 — sector distances and tracking
// quality only, never the full depth map.
type LidarContext = {
  left: { distanceM: number; confidence: string } | null;
  center: { distanceM: number; confidence: string } | null;
  right: { distanceM: number; confidence: string } | null;
  corridorRisk: string;
  corridorDistanceM: number | null;
  timeToContactS: number | null;
  tracking: string;
  ageMs: number;
};

function compactSector(reading: SectorReading): LidarContext['left'] {
  if (reading.distanceM === null || reading.coverage < 0.3) return null;
  return {
    distanceM: Math.round(reading.distanceM * 10) / 10,
    confidence: reading.confidence,
  };
}

export function compactLidarContext(snapshot: ObstacleSnapshot | null): LidarContext | null {
  if (!snapshot) return null;
  return {
    left: compactSector(snapshot.left),
    center: compactSector(snapshot.center),
    right: compactSector(snapshot.right),
    corridorRisk: snapshot.corridor.risk,
    corridorDistanceM:
      snapshot.corridor.distanceM !== null
        ? Math.round(snapshot.corridor.distanceM * 10) / 10
        : null,
    timeToContactS:
      snapshot.corridor.timeToContactS !== null
        ? Math.round(snapshot.corridor.timeToContactS * 10) / 10
        : null,
    tracking: snapshot.tracking,
    ageMs: Math.max(0, Date.now() - snapshot.timestampMs),
  };
}

export type SceneHazard = {
  label: string;
  direction: 'left' | 'center' | 'right';
  proximity: 'immediate' | 'near' | 'far' | 'unknown';
  confidence: 'low' | 'medium' | 'high';
};

const HAZARDS_URL = SCENE_URL?.replace('/describe-scene', '/hazards');

// Structured hazard extraction (Baseten structured outputs, GLM-5.3-Flash).
// Fired in parallel with the spoken description using the same frame — never
// blocks or delays speech.
async function fetchHazards(
  imageBase64: string,
  snapshot: ObstacleSnapshot | null,
): Promise<SceneHazard[]> {
  if (!HAZARDS_URL) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(HAZARDS_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(APP_SECRET ? { 'x-app-secret': APP_SECRET } : {}),
      },
      body: JSON.stringify({
        imageBase64,
        mimeType: 'image/jpeg',
        lidar: compactLidarContext(snapshot),
      }),
    });
    if (!response.ok) return [];
    const { hazards } = (await response.json()) as { hazards?: SceneHazard[] };
    return Array.isArray(hazards) ? hazards : [];
  } catch {
    return []; // hazards are supplementary — fail silent, never block speech
  } finally {
    clearTimeout(timeout);
  }
}

let inFlight: Promise<string> | null = null;

// Grabs the current ARKit camera frame and posts it, with compact LiDAR
// context, to the trusted scene-description proxy (server/index.mjs), which
// holds the Baseten API key. Frames are only sent on explicit request, and
// repeated requests coalesce onto the one already in flight.
export function describeCurrentScene(
  snapshot: ObstacleSnapshot | null = null,
  onDelta?: (delta: string) => void,
): Promise<string> {
  inFlight ??= requestDescription(snapshot, onDelta).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

// Captures a fresh frame and returns structured hazards. Runs in parallel
// with whatever speech is happening — never blocks it.
export async function fetchSceneHazards(
  snapshot: ObstacleSnapshot | null,
): Promise<SceneHazard[]> {
  const frame = await ExpoLidarVision.captureFrame(512, 0.5);
  const hazards = await fetchHazards(frame.base64, snapshot);
  console.log(`[hazards] received ${hazards.length}`);
  return hazards;
}

async function requestDescription(
  snapshot: ObstacleSnapshot | null,
  onDelta?: (delta: string) => void,
): Promise<string> {
  if (!SCENE_URL) throw new Error('Scene description backend is not configured.');

  // 512px halves the vision-token count vs 768px — fastest useful size.
  const frame = await ExpoLidarVision.captureFrame(512, 0.5);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(APP_SECRET ? { 'x-app-secret': APP_SECRET } : {}),
  };
  const body = {
    imageBase64: frame.base64,
    mimeType: 'image/jpeg',
    lidar: compactLidarContext(snapshot),
    // When streaming, ask the proxy to stream tokens back as SSE so on-device
    // TTS can start at the first sentence instead of after the full reply.
    ...(onDelta ? { stream: true } : {}),
  };
  try {
    const text = onDelta
      ? await streamSSE(SCENE_URL, headers, body, { onDelta, timeoutMs: STREAM_TIMEOUT_MS })
      : await postJSON(SCENE_URL, headers, body, REQUEST_TIMEOUT_MS);
    if (!text) throw new Error('No description returned.');
    return text;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Scene description timed out.');
    }
    throw error;
  }
}

// --- streaming helpers (shared with companion.ts) --------------------------

async function postJSON(url: string, headers: Record<string, string>, body: object, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Request failed (${response.status}).`);
    const json = (await response.json()) as { description?: string; reply?: string };
    return json.description ?? json.reply ?? '';
  } finally {
    clearTimeout(timeout);
  }
}

type StreamHandlers = { onDelta: (delta: string) => void; timeoutMs?: number };

export type SseParseResult = {
  deltas: string[];
  error: string | null;
  done: boolean;
  nextOffset: number;
};

// Pure SSE parser. Given the full responseText accumulated so far and the byte
// offset already consumed, returns the delta/error events in any newly complete
// `data:` lines plus the offset to consume up to next. Only newline-terminated
// lines are processed; a trailing partial line is left (nextOffset points just
// past the last newline) so it is re-examined once more bytes arrive. Extracted
// from the XHR plumbing so the offset-slicing logic is unit-testable without a
// device — that logic is the riskiest part and cannot be exercised on-device here.
export function parseSseChunk(text: string, startOffset: number): SseParseResult {
  const deltas: string[] = [];
  let error: string | null = null;
  let done = false;
  const tail = text.slice(startOffset);
  const lastNl = tail.lastIndexOf('\n');
  if (lastNl < 0) return { deltas, error, done, nextOffset: startOffset };
  const complete = tail.slice(0, lastNl);
  const nextOffset = startOffset + lastNl + 1;
  for (const line of complete.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') {
      done = true;
      continue;
    }
    let parsed: { delta?: string; error?: string };
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (typeof parsed.delta === 'string') deltas.push(parsed.delta);
    if (typeof parsed.error === 'string') error = parsed.error;
  }
  return { deltas, error, done, nextOffset };
}

// POSTs `body` to `url` and streams the Server-Sent Events response, invoking
// onDelta for each `data: {"delta": ...}` event. Resolves with the full reply.
//
// Uses XMLHttpRequest on purpose: React Native's fetch (RN 0.86) does not
// expose a streaming response body — `response.body` is null on device — so
// the SSE tokens would be buffered until the whole reply arrives and the
// streaming win is lost. XHR's `onprogress` fires as bytes arrive and
// `responseText` grows incrementally, which is what lets us parse each token
// the moment the proxy forwards it.
export function streamSSE(
  url: string,
  headers: Record<string, string>,
  body: object,
  { onDelta, timeoutMs = 15_000 }: StreamHandlers,
): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const xhr = new XMLHttpRequest();
  xhr.open('POST', url);
  for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
  xhr.responseType = 'text';
  // Stall timeout, not a wall-clock deadline. A streamed reply can take well
  // over 10s to its first token on a cold vision model, and inter-token gaps
  // are normal — a fixed xhr.timeout would abort mid-sentence after the user
  // has already heard part of it. So we arm a timer now, reset it on every
  // delta in pump(), and only abort if the stream goes silent for `timeoutMs`.
  // clearTimeout on an already-fired handle is a no-op, so no null guards.
  let stallTimer = setTimeout(() => xhr.abort(), timeoutMs);
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => xhr.abort(), timeoutMs);
  };


  let processed = 0; // how far into responseText we've consumed
  let full = '';
  let streamError: Error | null = null;
  let settled = false;

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(stallTimer);
    fn();
  };

  const pump = () => {
    const text = xhr.responseText ?? '';
    if (text.length <= processed) return;
    const result = parseSseChunk(text, processed);
    processed = result.nextOffset;
    if (result.deltas.length > 0) {
      for (const delta of result.deltas) {
        full += delta;
        onDelta(delta);
      }
      // Tokens are still flowing — push the stall deadline forward.
      armStall();
    }
    if (result.error) streamError = new Error(result.error);
  };

  xhr.onprogress = pump;
  xhr.onload = () => {
    pump();
    settle(() => {
      if (streamError) reject(streamError);
      else if (xhr.status >= 200 && xhr.status < 300) resolve(full);
      else reject(new Error(`Stream failed (${xhr.status}).`));
    });
  };
  xhr.onerror = () => settle(() => reject(new Error('Stream network error.')));
  // The stall timer calls xhr.abort() when the stream goes silent; abort fires
  // onabort (not ontimeout, since we never set xhr.timeout), which rejects so
  // callers never hang.
  xhr.onabort = () =>
    settle(() =>
      reject(Object.assign(new Error('Stream timed out.'), { name: 'AbortError' })),
    );

  xhr.send(JSON.stringify(body));
  return promise;
}
