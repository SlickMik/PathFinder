import {
  DEFAULT_LIDAR_OPTIONS,
  MINIMUM_RELIABLE_COVERAGE,
} from '../../config/thresholds';
import type {
  NavigationGuidance,
  NavigationInstruction,
  ObstacleSnapshot,
  SafetyEnvelope,
  SectorReading,
} from './types';

const PHRASES: Record<NavigationInstruction, string | null> = {
  hold: null,
  stop: 'Stop.',
  straight: 'Go straight.',
  'slight-left': 'Go slightly left.',
  left: 'Go left.',
  'slight-right': 'Go slightly right.',
  right: 'Go right.',
};

export const INITIAL_NAVIGATION_GUIDANCE: NavigationGuidance = {
  instruction: 'hold',
  phrase: null,
  confidence: 0,
  clearanceM: null,
  openingWidthM: null,
  isNarrowOpening: false,
  source: 'none',
  pendingInstruction: null,
  pendingFrameCount: 0,
};

type Candidate = {
  instruction: 'left' | 'right';
  clearanceM: number;
  coverage: number;
};

function reliable(reading: SectorReading): boolean {
  return (
    reading.confidence !== 'low' &&
    reading.coverage >= MINIMUM_RELIABLE_COVERAGE
  );
}

function clearance(reading: SectorReading): number {
  return reading.distanceM ?? DEFAULT_LIDAR_OPTIONS.maximumDistanceM;
}

export function planNavigation(
  snapshot: ObstacleSnapshot,
  envelope: SafetyEnvelope,
): NavigationGuidance {
  if (snapshot.tracking !== 'normal' || snapshot.deviceAim !== 'forward') {
    return INITIAL_NAVIGATION_GUIDANCE;
  }

  const route = snapshot.route;
  const routeIsUsable =
    route &&
    route.status !== 'unknown' &&
    route.confidence >= (route.status === 'blocked' ? 0.25 : 0.45);
  if (routeIsUsable) {
    const planned = guidance(
      route.instruction,
      route.minimumClearanceM,
      route.confidence,
    );
    return {
      ...planned,
      phrase: route.isNarrowOpening
        ? narrowOpeningPhrase(route.instruction)
        : planned.phrase,
      openingWidthM: route.openingWidthM,
      isNarrowOpening: route.isNarrowOpening,
      source: 'lidar-route',
    };
  }

  const centerReliable = reliable(snapshot.center);
  if (!centerReliable) {
    return INITIAL_NAVIGATION_GUIDANCE;
  }
  const centerClearance = centerReliable ? clearance(snapshot.center) : 0;
  if (centerReliable && centerClearance >= envelope.warningDistanceM) {
    return guidance('straight', centerClearance, snapshot.center.coverage);
  }

  const candidates: Candidate[] = [];
  if (reliable(snapshot.left)) {
    candidates.push({
      instruction: 'left',
      clearanceM: clearance(snapshot.left),
      coverage: snapshot.left.coverage,
    });
  }
  if (reliable(snapshot.right)) {
    candidates.push({
      instruction: 'right',
      clearanceM: clearance(snapshot.right),
      coverage: snapshot.right.coverage,
    });
  }
  candidates.sort((a, b) => {
    const clearanceDifference = b.clearanceM - a.clearanceM;
    if (Math.abs(clearanceDifference) > 0.15) return clearanceDifference;
    return b.coverage - a.coverage;
  });

  const best = candidates[0];
  const minimumSideClearance = Math.max(1, envelope.nearDistanceM);
  if (!best || best.clearanceM < minimumSideClearance) {
    if (centerReliable && centerClearance >= envelope.nearDistanceM) {
      return guidance('straight', centerClearance, snapshot.center.coverage);
    }
    return guidance('stop', centerReliable ? centerClearance : null, snapshot.corridor.coverage);
  }

  const improvement = best.clearanceM - centerClearance;
  if (
    centerReliable &&
    centerClearance >= envelope.nearDistanceM &&
    improvement < 0.55
  ) {
    return guidance('straight', centerClearance, snapshot.center.coverage);
  }

  const fullTurn =
    centerClearance < envelope.criticalDistanceM ||
    improvement >= 1.25;
  const instruction: NavigationInstruction = fullTurn
    ? best.instruction
    : best.instruction === 'left'
      ? 'slight-left'
      : 'slight-right';
  return guidance(instruction, best.clearanceM, best.coverage);
}

export function reduceNavigationGuidance(
  previous: NavigationGuidance,
  planned: NavigationGuidance,
): NavigationGuidance {
  if (planned.instruction === 'stop') {
    return { ...planned, pendingInstruction: null, pendingFrameCount: 0 };
  }

  if (planned.instruction === previous.instruction) {
    return { ...planned, pendingInstruction: null, pendingFrameCount: 0 };
  }

  const samePending = previous.pendingInstruction === planned.instruction;
  const pendingFrameCount = samePending ? previous.pendingFrameCount + 1 : 1;
  const framesRequired = previous.instruction === 'stop' ? 4 : 3;
  if (pendingFrameCount < framesRequired) {
    return {
      ...previous,
      pendingInstruction: planned.instruction,
      pendingFrameCount,
    };
  }

  return { ...planned, pendingInstruction: null, pendingFrameCount: 0 };
}

function guidance(
  instruction: NavigationInstruction,
  clearanceM: number | null,
  confidence: number,
): NavigationGuidance {
  return {
    instruction,
    phrase: PHRASES[instruction],
    confidence,
    clearanceM,
    openingWidthM: null,
    isNarrowOpening: false,
    source: 'reactive-sectors',
    pendingInstruction: null,
    pendingFrameCount: 0,
  };
}

function narrowOpeningPhrase(instruction: NavigationInstruction): string {
  if (instruction === 'slight-left' || instruction === 'left') {
    return 'Narrow opening ahead. Move left, then keep centered and go slowly.';
  }
  if (instruction === 'slight-right' || instruction === 'right') {
    return 'Narrow opening ahead. Move right, then keep centered and go slowly.';
  }
  return 'Narrow opening ahead. Keep centered and move slowly.';
}
