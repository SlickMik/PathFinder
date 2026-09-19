import type { EventSubscription } from 'expo-modules-core';
import NativeModule from './src/ExpoLidarVisionModule';
import type {
  LidarOptions,
  LidarSessionError,
  LidarSupport,
  ObstacleSnapshot,
} from '../../features/scanning/types';

const emptySubscription: EventSubscription = { remove() {} };

export const ExpoLidarVision = {
  async isSupported(): Promise<LidarSupport> {
    if (!NativeModule) return { supported: false, reason: 'no-lidar' };
    return NativeModule.isSupported();
  },

  async requestPermission(): Promise<boolean> {
    if (!NativeModule) return false;
    return NativeModule.requestPermission();
  },

  async start(options: LidarOptions): Promise<void> {
    if (!NativeModule) throw new Error('LiDAR is unavailable on this build.');
    return NativeModule.start(options);
  },

  async stop(): Promise<void> {
    if (!NativeModule) return;
    return NativeModule.stop();
  },

  onSnapshot(listener: (snapshot: ObstacleSnapshot) => void): EventSubscription {
    return NativeModule?.addListener('onObstacleSnapshot', listener) ?? emptySubscription;
  },

  onError(listener: (error: LidarSessionError) => void): EventSubscription {
    return NativeModule?.addListener('onSessionError', listener) ?? emptySubscription;
  },
};
