import type { NativeModule } from 'expo';
import type { EventSubscription } from 'expo-modules-core';
import type {
  CapturedFrame,
  LidarOptions,
  LidarSessionError,
  LidarSupport,
  ObstacleSnapshot,
} from '../../../features/scanning/types';

export type ExpoLidarVisionEvents = {
  onObstacleSnapshot: (snapshot: ObstacleSnapshot) => void;
  onSessionError: (error: LidarSessionError) => void;
};

export declare class ExpoLidarVisionNativeModule extends NativeModule<ExpoLidarVisionEvents> {
  isSupported(): Promise<LidarSupport>;
  requestPermission(): Promise<boolean>;
  start(options: LidarOptions): Promise<void>;
  stop(): Promise<void>;
  captureFrame(maxDimension: number, quality: number): Promise<CapturedFrame>;
  addListener<EventName extends keyof ExpoLidarVisionEvents>(
    eventName: EventName,
    listener: ExpoLidarVisionEvents[EventName],
  ): EventSubscription;
}
