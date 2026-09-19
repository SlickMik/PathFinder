import {
  MINIMUM_RELIABLE_COVERAGE,
  MOTION_SAFETY,
  RISK_THRESHOLDS_M,
} from '../../config/thresholds';
import type { ObstacleSnapshot, Risk, SafetyEnvelope } from './types';

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

/**
 * Builds a conservative forward warning envelope from horizontal device speed.
 *
 * warning distance = base margin + reaction distance + braking distance
 * reaction distance = speed * configured reaction time
 * braking distance = speed^2 / (2 * comfortable deceleration)
 */
export function safetyEnvelopeForSpeed(
  measuredSpeedMps: number,
  reactionTimeS: number,
): SafetyEnvelope {
  const speedMps = clamp(
    Number.isFinite(measuredSpeedMps) ? measuredSpeedMps : 0,
    0,
    MOTION_SAFETY.maximumEvaluatedSpeedMps,
  );
  const reactionDistanceM = speedMps * reactionTimeS;
  const brakingDistanceM =
    (speedMps * speedMps) / (2 * MOTION_SAFETY.comfortableDecelerationMps2);
  const warningDistanceM = clamp(
    MOTION_SAFETY.baseSafetyMarginM + reactionDistanceM + brakingDistanceM,
    RISK_THRESHOLDS_M.caution,
    MOTION_SAFETY.maximumWarningDistanceM,
  );
  const criticalDistanceM = Math.min(
    RISK_THRESHOLDS_M.critical + speedMps * 0.2,
    warningDistanceM - 0.75,
  );
  const nearDistanceM = Math.min(
    Math.max(
      RISK_THRESHOLDS_M.near + speedMps * 0.45,
      criticalDistanceM + 0.35,
    ),
    warningDistanceM - 0.35,
  );

  return {
    speedMps,
    reactionDistanceM,
    brakingDistanceM,
    warningDistanceM,
    criticalDistanceM,
    nearDistanceM,
  };
}

export function corridorRisk(
  snapshot: ObstacleSnapshot,
  envelope: SafetyEnvelope,
  reactionTimeS: number,
): Risk {
  if (
    snapshot.tracking !== 'normal' ||
    snapshot.deviceAim !== 'forward' ||
    snapshot.corridor.coverage < MINIMUM_RELIABLE_COVERAGE
  ) {
    return 'unknown';
  }

  const distance = snapshot.corridor.distanceM;
  if (distance === null) return 'clear';

  const timeToContact = snapshot.corridor.timeToContactS;
  if (
    distance < envelope.criticalDistanceM ||
    (timeToContact !== null && timeToContact <= Math.max(0.65, reactionTimeS * 0.5))
  ) {
    return 'critical';
  }
  if (
    distance < envelope.nearDistanceM ||
    (timeToContact !== null && timeToContact <= reactionTimeS)
  ) {
    return 'near';
  }
  if (
    distance <= envelope.warningDistanceM ||
    (timeToContact !== null && timeToContact <= reactionTimeS + 1)
  ) {
    return 'caution';
  }
  return 'clear';
}
