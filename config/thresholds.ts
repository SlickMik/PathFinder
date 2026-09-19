import type { LidarOptions } from '../features/scanning/types';

export const DEFAULT_LIDAR_OPTIONS: LidarOptions = {
  updateHz: 10,
  minimumConfidence: 'medium',
  maximumDistanceM: 5,
  corridorWidthM: 0.9,
  reactionTimeS: 1.5,
};

export const RISK_THRESHOLDS_M = {
  critical: 0.6,
  near: 1.2,
  caution: 2,
} as const;

export const MOTION_SAFETY = {
  maximumEvaluatedSpeedMps: 2.5,
  comfortableDecelerationMps2: 1.4,
  baseSafetyMarginM: 0.6,
  maximumWarningDistanceM: DEFAULT_LIDAR_OPTIONS.maximumDistanceM,
} as const;

export const MINIMUM_RELIABLE_COVERAGE = 0.22;
export const SAFER_FRAMES_TO_EXIT = 4;
export const UNKNOWN_FRAMES_TO_PAUSE = 3;
