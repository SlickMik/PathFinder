import Constants from 'expo-constants';

function developmentProxyUrl(): string | undefined {
  if (!__DEV__) return undefined;

  // Expo CLI exposes the Metro host to the development client. Reuse that
  // host for the local PathFinder proxy when the supervisor's env injection
  // was skipped (for example, when running `npx expo run:ios` directly).
  const hostUri = Constants.expoConfig?.hostUri;
  if (!hostUri) return undefined;

  const host = hostUri.startsWith('[')
    ? hostUri.slice(1, hostUri.indexOf(']'))
    : hostUri.split(':')[0];
  return host ? `http://${host}:8787/describe-scene` : undefined;
}

export const SCENE_URL =
  process.env.EXPO_PUBLIC_SCENE_DESCRIBE_URL ?? developmentProxyUrl();

export const APP_SECRET = process.env.EXPO_PUBLIC_SCENE_APP_SECRET;
