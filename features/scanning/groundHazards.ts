import { GROUND_HAZARDS } from '../../config/thresholds';
import type {
  GroundHazardAlertState,
  GroundHazardKind,
  ObstacleSnapshot,
  Risk,
} from './types';

export const INITIAL_GROUND_HAZARD_STATE: GroundHazardAlertState = {
  active: null,
  distanceM: null,
  dropOffFrameCount: 0,
  tripFrameCount: 0,
  clearFrameCount: 0,
  lastSpokenPhrase: null,
  announcement: null,
};

/**
 * Rounds to half-metre buckets so the spoken phrase stays stable while the
 * user approaches a hazard, and only changes when the situation truly changes.
 */
function distancePhrase(distanceM: number | null): string {
  if (distanceM === null) return 'ahead';
  if (distanceM < 1) return 'less than one metre ahead';
  const rounded = Math.round(distanceM * 2) / 2;
  return `about ${rounded} ${rounded === 1 ? 'metre' : 'metres'} ahead`;
}

function phraseFor(
  kind: GroundHazardKind,
  distanceM: number | null,
  depthM: number | null,
): string {
  const stop =
    distanceM !== null && distanceM <= GROUND_HAZARDS.stopDistanceM ? 'Stop. ' : '';
  if (kind === 'drop-off') {
    const label =
      depthM !== null && depthM <= GROUND_HAZARDS.stepDownMaxDepthM
        ? 'Step down'
        : 'Drop-off';
    return `${stop}${label} ${distancePhrase(distanceM)}.`;
  }
  return `${stop}Trip hazard, low obstacle ${distancePhrase(distanceM)}.`;
}

function withinRange(distanceM: number | null): boolean {
  return distanceM === null || distanceM <= GROUND_HAZARDS.maximumAnnounceDistanceM;
}

function activated(
  previous: GroundHazardAlertState,
  kind: GroundHazardKind,
  distanceM: number | null,
  depthM: number | null,
  dropOffFrameCount: number,
  tripFrameCount: number,
): GroundHazardAlertState {
  const phrase = phraseFor(kind, distanceM, depthM);
  return {
    active: kind,
    distanceM,
    dropOffFrameCount,
    tripFrameCount,
    clearFrameCount: 0,
    lastSpokenPhrase: phrase,
    // Speak only when the phrase changed; buckets in distancePhrase keep it
    // stable, so approaching a hazard re-announces roughly every half metre.
    announcement: phrase === previous.lastSpokenPhrase ? null : phrase,
  };
}

/**
 * Frame-level hysteresis for ground hazards (drop-offs and trip hazards).
 * Native code reports raw evidence; this reducer decides when it is stable
 * enough to interrupt the user, mirroring the obstacle alert policy split.
 */
export function reduceGroundHazardState(
  previous: GroundHazardAlertState,
  snapshot: ObstacleSnapshot,
): GroundHazardAlertState {
  const hazards = snapshot.hazards;
  const viewValid =
    snapshot.tracking === 'normal' && snapshot.deviceAim === 'forward';

  // Without a valid view and a classified floor plane, below-floor and
  // low-band evidence is meaningless. Treat these frames as hazard-free.
  const dropOffSeen =
    viewValid &&
    hazards !== undefined &&
    hazards.floorDetected &&
    hazards.dropOff.detected &&
    withinRange(hazards.dropOff.distanceM);
  const tripSeen =
    viewValid &&
    hazards !== undefined &&
    hazards.floorDetected &&
    hazards.tripHazard.detected &&
    withinRange(hazards.tripHazard.distanceM);

  const dropOffFrameCount = dropOffSeen ? previous.dropOffFrameCount + 1 : 0;
  const tripFrameCount = tripSeen ? previous.tripFrameCount + 1 : 0;

  // A drop-off always dominates a trip hazard: it is the more dangerous miss.
  if (dropOffFrameCount >= GROUND_HAZARDS.framesToConfirmDropOff) {
    return activated(
      previous,
      'drop-off',
      hazards?.dropOff.distanceM ?? null,
      hazards?.dropOff.depthM ?? null,
      dropOffFrameCount,
      tripFrameCount,
    );
  }

  if (tripFrameCount >= GROUND_HAZARDS.framesToConfirmTrip) {
    return activated(
      previous,
      'trip-hazard',
      hazards?.tripHazard.distanceM ?? null,
      null,
      dropOffFrameCount,
      tripFrameCount,
    );
  }

  if (previous.active === null) {
    return { ...previous, dropOffFrameCount, tripFrameCount, announcement: null };
  }

  const clearFrameCount = previous.clearFrameCount + 1;
  if (clearFrameCount < GROUND_HAZARDS.framesToClear) {
    return {
      ...previous,
      dropOffFrameCount,
      tripFrameCount,
      clearFrameCount,
      announcement: null,
    };
  }

  return {
    ...INITIAL_GROUND_HAZARD_STATE,
    dropOffFrameCount,
    tripFrameCount,
  };
}

/** Maps the active ground hazard onto the shared risk scale used by haptics. */
export function groundHazardRisk(state: GroundHazardAlertState): Risk {
  if (state.active === null) return 'clear';
  const close =
    state.distanceM !== null && state.distanceM <= GROUND_HAZARDS.stopDistanceM;
  if (state.active === 'drop-off') return close ? 'critical' : 'near';
  return close ? 'near' : 'caution';
}

const RISK_RANK: Record<Risk, number> = {
  unknown: -1,
  clear: 0,
  caution: 1,
  near: 2,
  critical: 3,
};

/** Returns whichever risk demands the more urgent feedback. */
export function escalateRisk(a: Risk, b: Risk): Risk {
  return RISK_RANK[b] > RISK_RANK[a] ? b : a;
}
