import { ExpoLidarVision } from "../../modules/expo-lidar-vision";
import { APP_SECRET, SCENE_URL } from "./backendConfig";
import { CLOUD_AI_ENABLED } from "./featureFlags";
import { compactLidarContext, streamSSE } from "./sceneDescriber";
import type {
  AlertState,
  NavigationGuidance,
  ObstacleSnapshot,
} from "../scanning/types";

// Companion mode: turns the journey into a running conversation with a warm
// voice ("Path") instead of terse announcements. Deterministic obstacle
// alerts are NOT routed through this — they stay local and instant.

const COMPANION_URL =
  process.env.EXPO_PUBLIC_COMPANION_URL ??
  SCENE_URL?.replace("/describe-scene", "/companion");
const REQUEST_TIMEOUT_MS = 15_000;
// Streamed replies get a larger no-delta budget than a buffered round-trip: a
// cold vision model can take ~13s to its first token, and the stall timer only
// resets once tokens flow.
const STREAM_TIMEOUT_MS = 25_000;
const MAX_TURNS = 16;

type Turn = { role: "user" | "assistant"; content: string };

const history: Turn[] = [];
let inFlight: Promise<string> | null = null;

export function resetCompanion(): void {
  history.length = 0;
}

const UNDERSTAND_URL = COMPANION_URL?.replace("/companion", "/understand");

let understandAvailable: boolean | null = null;
async function canUnderstandAudio(): Promise<boolean> {
  if (!CLOUD_AI_ENABLED) return false;
  if (understandAvailable !== null) return understandAvailable;
  try {
    const base = COMPANION_URL?.replace("/companion", "");
    if (!base) return (understandAvailable = false);
    const response = await fetch(`${base}/health`);
    const { understand } = (await response.json()) as { understand?: boolean };
    understandAvailable = Boolean(understand);
  } catch {
    understandAvailable = false;
  }
  console.log(
    `[companion] Gemini audio understanding available: ${understandAvailable}`,
  );
  return understandAvailable;
}

// Gemini ears: send the user's raw audio (plus a camera frame and LiDAR context)
// to the backend. Gemini transcribes and answers in one multimodal request.
// Returns null when unconfigured/failed so callers fall back to the
// on-device transcript path.
export async function understandAudio(
  audioBase64: string,
  audioMime: string,
  options: CompanionOptions = {},
): Promise<{ transcript: string; reply: string } | null> {
  if (!UNDERSTAND_URL || !(await canUnderstandAudio())) return null;
  const {
    snapshot = null,
    alert = null,
    guidance = null,
    events = [],
    withFrame = false,
  } = options;
  try {
    const frame = withFrame
      ? await ExpoLidarVision.captureFrame(512, 0.5)
      : null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(UNDERSTAND_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(APP_SECRET ? { "x-app-secret": APP_SECRET } : {}),
        },
        body: JSON.stringify({
          audioBase64,
          audioMime,
          history,
          events: events.slice(-6),
          lidar: buildLidarPayload(snapshot, alert, guidance),
          ...(frame
            ? { imageBase64: frame.base64, mimeType: "image/jpeg" }
            : {}),
        }),
      });
      if (!response.ok)
        throw new Error(`Understand failed (${response.status}).`);
      const { transcript, reply } = (await response.json()) as {
        transcript?: string;
        reply?: string;
      };
      if (!transcript || !reply)
        throw new Error("Incomplete understand response.");
      history.push(
        { role: "user", content: transcript },
        { role: "assistant", content: reply },
      );
      while (history.length > MAX_TURNS) history.splice(0, 2);
      return { transcript, reply };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.warn("[companion] understandAudio failed, falling back:", error);
    return null;
  }
}

function buildLidarPayload(
  snapshot: ObstacleSnapshot | null,
  alert: AlertState | null,
  guidance: NavigationGuidance | null,
) {
  return {
    ...(compactLidarContext(snapshot) ?? {}),
    alert: alert ? { risk: alert.risk, direction: alert.direction } : null,
    guidance:
      guidance && guidance.instruction !== "hold"
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
export function companionSay(
  text: string,
  options: CompanionOptions = {},
): Promise<string> {
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
  if (!CLOUD_AI_ENABLED) throw new Error("Cloud AI is disabled.");
  if (!COMPANION_URL) throw new Error("Companion backend is not configured.");
  console.log(
    `[companion] POST ${COMPANION_URL} (frame=${withFrame}, stream=${!!onDelta})`,
  );

  // 512px halves the vision-token count vs 768px — fastest useful size.
  const frame = withFrame ? await ExpoLidarVision.captureFrame(512, 0.5) : null;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(APP_SECRET ? { "x-app-secret": APP_SECRET } : {}),
  };
  const lidar = buildLidarPayload(snapshot, alert, guidance);
  const body = {
    text,
    history,
    events: events.slice(-6),
    lidar,
    ...(frame ? { imageBase64: frame.base64, mimeType: "image/jpeg" } : {}),
    // Streaming: ask the proxy to forward tokens as SSE so on-device TTS can
    // begin at the first sentence. Without onDelta we keep the simple JSON
    // round-trip (one buffered response).
    ...(onDelta ? { stream: true } : {}),
  };

  try {
    const reply = onDelta
      ? await streamSSE(COMPANION_URL, headers, body, {
          onDelta,
          timeoutMs: STREAM_TIMEOUT_MS,
        })
      : await postReply(COMPANION_URL, headers, body, REQUEST_TIMEOUT_MS);
    if (!reply) throw new Error("No reply returned.");

    history.push(
      { role: "user", content: text },
      { role: "assistant", content: reply },
    );
    while (history.length > MAX_TURNS) history.splice(0, 2);
    return reply;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Companion timed out.");
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
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(`Companion request failed (${response.status}).`);
    const { reply } = (await response.json()) as { reply?: string };
    return reply ?? "";
  } finally {
    clearTimeout(timeout);
  }
}
