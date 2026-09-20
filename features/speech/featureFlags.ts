function enabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? '');
}

// Cloud features are deliberately opt-in while the Gemini/ElevenLabs path is
// being stabilized. Local LiDAR, segmentation, haptics, and device speech do
// not depend on this flag.
export const CLOUD_AI_ENABLED = enabled(process.env.EXPO_PUBLIC_CLOUD_AI_ENABLED);
