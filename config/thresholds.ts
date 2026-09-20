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

export const GROUND_HAZARDS = {
  /** Consecutive detected frames before a drop-off alert fires (~200 ms at 10 Hz). */
  framesToConfirmDropOff: 2,
  /** Trip hazards are sparser evidence, so require slightly more agreement. */
  framesToConfirmTrip: 3,
  /** Consecutive hazard-free frames before an active hazard alert clears. */
  framesToClear: 5,
  /** Ignore hazard evidence further away than this; near-field only. */
  maximumAnnounceDistanceM: 3.5,
  /** Within this range the announcement leads with "Stop." */
  stopDistanceM: 1.3,
  /** Below-floor depth at or under this is phrased as a step down, not a drop-off. */
  stepDownMaxDepthM: 0.45,
} as const;

export const MINIMUM_RELIABLE_COVERAGE = 0.22;
export const SAFER_FRAMES_TO_EXIT = 4;
export const UNKNOWN_FRAMES_TO_PAUSE = 3;
