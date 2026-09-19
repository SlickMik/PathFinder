import {
  INITIAL_NAVIGATION_GUIDANCE,
  planNavigation,
  reduceNavigationGuidance,
} from '../features/scanning/navigation';
import { safetyEnvelopeForSpeed } from '../features/scanning/motionSafety';
import type { ObstacleSnapshot, SectorReading } from '../features/scanning/types';

const reading = (distanceM: number | null): SectorReading => ({
  distanceM,
  confidence: 'high',
  coverage: 0.8,
});

const snapshot = (
  left: number | null,
  center: number | null,
  right: number | null,
): ObstacleSnapshot => ({
  timestampMs: 1,
  tracking: 'normal',
  deviceAim: 'forward',
  motion: { speedMps: 0 },
  left: reading(left),
  center: reading(center),
  right: reading(right),
  corridor: {
    distanceM: center,
    timeToContactS: null,
    coverage: 0.8,
    risk: 'clear',
  },
});

const envelope = safetyEnvelopeForSpeed(0, 1.5);

describe('reactive LiDAR navigation', () => {
  it('continues straight through an open center corridor', () => {
    expect(planNavigation(snapshot(1, null, 1), envelope).instruction).toBe('straight');
  });

  it('chooses the side with more clearance', () => {
    expect(planNavigation(snapshot(4, 0.8, 1.3), envelope).instruction).toBe('left');
  });

  it('stops when no measured sector has enough clearance', () => {
    expect(planNavigation(snapshot(0.7, 0.5, 0.8), envelope).instruction).toBe('stop');
  });

  it('does not steer through an unreliable center view', () => {
    const value = snapshot(null, null, null);
    value.center.coverage = 0.05;
    expect(planNavigation(value, envelope).instruction).toBe('hold');
  });

  it('requires three frames before changing a noncritical direction', () => {
    const planned = planNavigation(snapshot(4, 0.8, 1.3), envelope);
    let state = reduceNavigationGuidance(INITIAL_NAVIGATION_GUIDANCE, planned);
    expect(state.instruction).toBe('hold');
    state = reduceNavigationGuidance(state, planned);
    expect(state.instruction).toBe('hold');
    state = reduceNavigationGuidance(state, planned);
    expect(state.instruction).toBe('left');
  });

  it('commits a stop instruction immediately', () => {
    const planned = planNavigation(snapshot(0.7, 0.5, 0.8), envelope);
    expect(
      reduceNavigationGuidance(INITIAL_NAVIGATION_GUIDANCE, planned).instruction,
    ).toBe('stop');
  });

  it('prefers a confident native route through a measured narrow opening', () => {
    const value = snapshot(0.8, 0.7, 0.8);
    value.route = {
      instruction: 'slight-right',
      status: 'narrow',
      minimumClearanceM: 0.43,
      openingWidthM: 0.86,
      headingDeltaDeg: 11,
      confidence: 0.82,
      isNarrowOpening: true,
    };

    const result = planNavigation(value, envelope);
    expect(result.instruction).toBe('slight-right');
    expect(result.source).toBe('lidar-route');
    expect(result.isNarrowOpening).toBe(true);
    expect(result.phrase).toContain('keep centered');
  });

  it('falls back to sectors while the local route map is still uncertain', () => {
    const value = snapshot(4, 0.8, 1.3);
    value.route = {
      instruction: 'right',
      status: 'clear',
      minimumClearanceM: 0.7,
      openingWidthM: 1.4,
      headingDeltaDeg: 20,
      confidence: 0.2,
      isNarrowOpening: false,
    };

    const result = planNavigation(value, envelope);
    expect(result.instruction).toBe('left');
    expect(result.source).toBe('reactive-sectors');
  });
});
