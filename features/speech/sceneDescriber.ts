import { ExpoLidarVision } from '../../modules/expo-lidar-vision';
import type { ObstacleSnapshot, SectorReading } from '../scanning/types';

const SCENE_URL = process.env.EXPO_PUBLIC_SCENE_DESCRIBE_URL;
const APP_SECRET = process.env.EXPO_PUBLIC_SCENE_APP_SECRET;
const REQUEST_TIMEOUT_MS = 15_000;

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

let inFlight: Promise<string> | null = null;

// Grabs the current ARKit camera frame and posts it, with compact LiDAR
// context, to the trusted scene-description proxy (server/index.mjs), which
// holds the Baseten API key. Frames are only sent on explicit request, and
// repeated requests coalesce onto the one already in flight.
export function describeCurrentScene(snapshot: ObstacleSnapshot | null = null): Promise<string> {
  inFlight ??= requestDescription(snapshot).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function requestDescription(snapshot: ObstacleSnapshot | null): Promise<string> {
  if (!SCENE_URL) throw new Error('Scene description backend is not configured.');

  // 512px halves the vision-token count vs 768px — fastest useful size.
  const frame = await ExpoLidarVision.captureFrame(512, 0.5);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(SCENE_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(APP_SECRET ? { 'x-app-secret': APP_SECRET } : {}),
      },
      body: JSON.stringify({
        imageBase64: frame.base64,
        mimeType: 'image/jpeg',
        lidar: compactLidarContext(snapshot),
      }),
    });
    if (!response.ok) throw new Error(`Scene description failed (${response.status}).`);
    const { description } = (await response.json()) as { description?: string };
    if (!description) throw new Error('No description returned.');
    return description;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Scene description timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
