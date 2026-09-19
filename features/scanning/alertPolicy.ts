import {
  DEFAULT_LIDAR_OPTIONS,
  MINIMUM_RELIABLE_COVERAGE,
  SAFER_FRAMES_TO_EXIT,
  UNKNOWN_FRAMES_TO_PAUSE,
} from '../../config/thresholds';
import { corridorRisk, safetyEnvelopeForSpeed } from './motionSafety';
import type {
  AlertState,
  ObstacleSnapshot,
  Risk,
  SafetyEnvelope,
  Sector,
  SectorReading,
} from './types';

const RISK_RANK: Record<Risk, number> = {
  unknown: -1,
  clear: 0,
  caution: 1,
  near: 2,
  critical: 3,
};

const DIRECTION_PRIORITY: Record<Sector, number> = {
  center: 2,
  left: 1,
  right: 0,
};

export const INITIAL_ALERT_STATE: AlertState = {
  risk: 'unknown',
  direction: null,
  saferFrameCount: 0,
  unknownFrameCount: 0,
  announcement: null,
};

export function riskForReading(
  reading: SectorReading,
  envelope: SafetyEnvelope = safetyEnvelopeForSpeed(
    0,
    DEFAULT_LIDAR_OPTIONS.reactionTimeS,
  ),
): Risk {
  if (
    reading.confidence === 'low' ||
    reading.coverage < MINIMUM_RELIABLE_COVERAGE
  ) {
    return 'unknown';
  }

  if (reading.distanceM === null) return 'clear';
  if (reading.distanceM < envelope.criticalDistanceM) return 'critical';
  if (reading.distanceM < envelope.nearDistanceM) return 'near';
  if (reading.distanceM <= envelope.warningDistanceM) return 'caution';
  return 'clear';
}

export function dominantSector(
  snapshot: ObstacleSnapshot,
  envelope: SafetyEnvelope = safetyEnvelopeForSpeed(
    snapshot.motion.speedMps,
    DEFAULT_LIDAR_OPTIONS.reactionTimeS,
  ),
): Sector | null {
  const sectors: Array<{ sector: Sector; reading: SectorReading; risk: Risk }> = (
    ['left', 'center', 'right'] as const
  ).map((sector) => ({
    sector,
    reading: snapshot[sector],
    risk: riskForReading(snapshot[sector], envelope),
  }));

  const reliable = sectors.filter(({ risk }) => risk !== 'unknown');
  if (reliable.length === 0) return null;

  reliable.sort((a, b) => {
    const rankDifference = RISK_RANK[b.risk] - RISK_RANK[a.risk];
    if (rankDifference !== 0) return rankDifference;

    const distanceDifference =
      (a.reading.distanceM ?? Number.POSITIVE_INFINITY) -
      (b.reading.distanceM ?? Number.POSITIVE_INFINITY);
    if (Math.abs(distanceDifference) > 0.05) return distanceDifference;

    return DIRECTION_PRIORITY[b.sector] - DIRECTION_PRIORITY[a.sector];
  });

  return reliable[0].sector;
}

function announcementFor(risk: Risk, direction: Sector | null): string | null {
  if (risk === 'critical') return 'Very close. Stop.';
  if (risk === 'near') return direction ? `Obstacle ${direction}.` : 'Obstacle ahead.';
  if (risk === 'caution') return direction ? `Obstacle ${direction}.` : 'Obstacle ahead.';
  return null;
}

export function reduceAlertState(
  previous: AlertState,
  snapshot: ObstacleSnapshot,
  envelope: SafetyEnvelope = safetyEnvelopeForSpeed(
    snapshot.motion.speedMps,
    DEFAULT_LIDAR_OPTIONS.reactionTimeS,
  ),
): AlertState {
  const invalidView = snapshot.tracking !== 'normal' || snapshot.deviceAim !== 'forward';
  const candidate: Risk = invalidView
    ? 'unknown'
    : corridorRisk(snapshot, envelope, DEFAULT_LIDAR_OPTIONS.reactionTimeS);

  if (candidate === 'unknown') {
    const unknownFrameCount = previous.unknownFrameCount + 1;
    if (unknownFrameCount < UNKNOWN_FRAMES_TO_PAUSE) {
      return { ...previous, unknownFrameCount, announcement: null };
    }

    return {
      risk: 'unknown',
      direction: null,
      saferFrameCount: 0,
      unknownFrameCount,
      announcement:
        previous.risk === 'unknown' ? null : 'View blocked. Reposition phone.',
    };
  }

  const direction = dominantSector(snapshot, envelope);
  const candidateRank = RISK_RANK[candidate];
  const previousRank = RISK_RANK[previous.risk];
  const riskIncreased = previous.risk === 'unknown' || candidateRank > previousRank;
  const directionChanged = direction !== previous.direction;

  if (riskIncreased || candidateRank === previousRank) {
    return {
      risk: candidate,
      direction,
      saferFrameCount: 0,
      unknownFrameCount: 0,
      announcement:
        riskIncreased || (directionChanged && candidate !== 'clear')
          ? announcementFor(candidate, direction)
          : null,
    };
  }

  const saferFrameCount = previous.saferFrameCount + 1;
  if (saferFrameCount < SAFER_FRAMES_TO_EXIT) {
    return {
      ...previous,
      saferFrameCount,
      unknownFrameCount: 0,
      announcement: null,
    };
  }

  return {
    risk: candidate,
    direction,
    saferFrameCount: 0,
    unknownFrameCount: 0,
    announcement: null,
  };
}
