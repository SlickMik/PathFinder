import { ExpoLidarVision } from '../../modules/expo-lidar-vision';

const SCENE_URL = process.env.EXPO_PUBLIC_SCENE_DESCRIBE_URL;

// Grabs the current ARKit camera frame and posts it to a vision backend that
// returns { description: string }. Frames are only sent on explicit request.
export async function describeCurrentScene(): Promise<string> {
  if (!SCENE_URL) throw new Error('Scene description backend is not configured.');
  const frame = await ExpoLidarVision.captureFrame(768, 0.6);
  const response = await fetch(SCENE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64: frame.base64, mimeType: 'image/jpeg' }),
  });
  if (!response.ok) throw new Error(`Scene description failed (${response.status}).`);
  const { description } = (await response.json()) as { description?: string };
  if (!description) throw new Error('No description returned.');
  return description;
}
