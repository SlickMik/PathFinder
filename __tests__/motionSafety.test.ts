import { DEFAULT_LIDAR_OPTIONS } from '../config/thresholds';
import {
  corridorRisk,
  safetyEnvelopeForSpeed,
} from '../features/scanning/motionSafety';
import type { ObstacleSnapshot } from '../features/scanning/types';

const snapshot = (distanceM: number | null, speedMps: number): ObstacleSnapshot => ({
  timestampMs: 1,
  tracking: 'normal',
  deviceAim: 'forward',
  motion: { speedMps },
  left: { distanceM: null, confidence: 'high', coverage: 0.8 },
  center: { distanceM, confidence: 'high', coverage: 0.8 },
  right: { distanceM: null, confidence: 'high', coverage: 0.8 },
  corridor: {
    distanceM,
    timeToContactS: null,
    coverage: 0.8,
    risk: 'clear',
  },
});

describe('speed-adaptive safety envelope', () => {
  it('keeps the original two-metre warning while stationary', () => {
    const envelope = safetyEnvelopeForSpeed(0, DEFAULT_LIDAR_OPTIONS.reactionTimeS);
    expect(envelope.warningDistanceM).toBe(2);
  });

  it('increases warning distance as speed rises', () => {
    const walking = safetyEnvelopeForSpeed(1, DEFAULT_LIDAR_OPTIONS.reactionTimeS);
    const fast = safetyEnvelopeForSpeed(2, DEFAULT_LIDAR_OPTIONS.reactionTimeS);
    expect(walking.warningDistanceM).toBeGreaterThan(2);
    expect(fast.warningDistanceM).toBeGreaterThan(walking.warningDistanceM);
  });

  it('starts warning sooner when moving quickly', () => {
    const value = snapshot(2.4, 1.5);
    const movingEnvelope = safetyEnvelopeForSpeed(
      value.motion.speedMps,
      DEFAULT_LIDAR_OPTIONS.reactionTimeS,
    );
    const stationaryEnvelope = safetyEnvelopeForSpeed(
      0,
      DEFAULT_LIDAR_OPTIONS.reactionTimeS,
    );
    expect(corridorRisk(value, stationaryEnvelope, 1.5)).toBe('clear');
    expect(corridorRisk(value, movingEnvelope, 1.5)).toBe('caution');
  });

  it('caps the warning range at LiDAR processing range', () => {
    const envelope = safetyEnvelopeForSpeed(20, DEFAULT_LIDAR_OPTIONS.reactionTimeS);
    expect(envelope.warningDistanceM).toBe(DEFAULT_LIDAR_OPTIONS.maximumDistanceM);
  });
});
