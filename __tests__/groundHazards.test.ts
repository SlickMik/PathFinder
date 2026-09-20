import { GROUND_HAZARDS } from '../config/thresholds';
import {
  INITIAL_GROUND_HAZARD_STATE,
  escalateRisk,
  groundHazardRisk,
  reduceGroundHazardState,
} from '../features/scanning/groundHazards';
import type {
  GroundHazardAlertState,
  GroundHazards,
  ObstacleSnapshot,
  SectorReading,
} from '../features/scanning/types';

const reliable = (distanceM: number | null): SectorReading => ({
  distanceM,
  confidence: 'high',
  coverage: 0.8,
});

const noHazards: GroundHazards = {
  floorDetected: true,
  dropOff: { detected: false, distanceM: null, depthM: null, sampleCount: 0 },
  tripHazard: { detected: false, distanceM: null, heightM: null, sampleCount: 0 },
};

const snapshot = (
  hazards: Partial<GroundHazards> | undefined,
  overrides: Partial<ObstacleSnapshot> = {},
): ObstacleSnapshot => ({
  timestampMs: 1,
  tracking: 'normal',
  deviceAim: 'forward',
  motion: { speedMps: 0 },
  left: reliable(3),
  center: reliable(3),
  right: reliable(3),
  corridor: { distanceM: 3, timeToContactS: null, coverage: 0.8, risk: 'clear' },
  hazards: hazards === undefined ? undefined : { ...noHazards, ...hazards },
  ...overrides,
});

const dropOff = (distanceM: number, depthM: number): Partial<GroundHazards> => ({
  dropOff: { detected: true, distanceM, depthM, sampleCount: 12 },
});

const trip = (distanceM: number): Partial<GroundHazards> => ({
  tripHazard: { detected: true, distanceM, heightM: 0.12, sampleCount: 8 },
});

const run = (
  frames: ObstacleSnapshot[],
  initial: GroundHazardAlertState = INITIAL_GROUND_HAZARD_STATE,
): GroundHazardAlertState =>
  frames.reduce((state, frame) => reduceGroundHazardState(state, frame), initial);

describe('reduceGroundHazardState', () => {
  it('does not alert on a single drop-off frame', () => {
    const state = reduceGroundHazardState(
      INITIAL_GROUND_HAZARD_STATE,
      snapshot(dropOff(2, 0.8)),
    );
    expect(state.active).toBeNull();
    expect(state.announcement).toBeNull();
    expect(state.dropOffFrameCount).toBe(1);
  });

  it('confirms a drop-off after consecutive frames and announces once', () => {
    const frames = Array.from(
      { length: GROUND_HAZARDS.framesToConfirmDropOff },
      () => snapshot(dropOff(2, 0.8)),
    );
    const state = run(frames);
    expect(state.active).toBe('drop-off');
    expect(state.announcement).toBe('Drop-off about 2 metres ahead.');

    const next = reduceGroundHazardState(state, snapshot(dropOff(2.1, 0.8)));
    expect(next.active).toBe('drop-off');
    expect(next.announcement).toBeNull();
  });

  it('phrases a shallow drop as a step down', () => {
    const frames = Array.from(
      { length: GROUND_HAZARDS.framesToConfirmDropOff },
      () => snapshot(dropOff(1.8, 0.2)),
    );
    expect(run(frames).announcement).toBe('Step down about 2 metres ahead.');
  });

  it('leads with Stop when the drop-off is close', () => {
    const frames = Array.from(
      { length: GROUND_HAZARDS.framesToConfirmDropOff },
      () => snapshot(dropOff(0.9, 0.9)),
    );
    expect(run(frames).announcement).toBe(
      'Stop. Drop-off less than one metre ahead.',
    );
  });

  it('re-announces when the user gets meaningfully closer', () => {
    const confirmed = run(
      Array.from({ length: GROUND_HAZARDS.framesToConfirmDropOff }, () =>
        snapshot(dropOff(2.6, 0.8)),
      ),
    );
    const closer = reduceGroundHazardState(confirmed, snapshot(dropOff(1.9, 0.8)));
    expect(closer.announcement).toBe('Drop-off about 2 metres ahead.');
  });

  it('confirms a trip hazard after its own frame threshold', () => {
    const frames = Array.from({ length: GROUND_HAZARDS.framesToConfirmTrip }, () =>
      snapshot(trip(1.6)),
    );
    const earlier = run(frames.slice(0, -1));
    expect(earlier.active).toBeNull();

    const state = run(frames);
    expect(state.active).toBe('trip-hazard');
    expect(state.announcement).toBe(
      'Trip hazard, low obstacle about 1.5 metres ahead.',
    );
  });

  it('prefers a drop-off over a simultaneous trip hazard', () => {
    const both = { ...dropOff(1.8, 0.7), ...trip(1.5) };
    const frames = Array.from(
      { length: Math.max(
        GROUND_HAZARDS.framesToConfirmDropOff,
        GROUND_HAZARDS.framesToConfirmTrip,
      ) },
      () => snapshot(both),
    );
    expect(run(frames).active).toBe('drop-off');
  });

  it('ignores evidence when no floor plane has been classified', () => {
    const frames = Array.from({ length: 6 }, () =>
      snapshot({ ...dropOff(1.5, 0.9), floorDetected: false }),
    );
    const state = run(frames);
    expect(state.active).toBeNull();
    expect(state.announcement).toBeNull();
  });

  it('ignores evidence while tracking or aim is invalid', () => {
    const frames = Array.from({ length: 6 }, () =>
      snapshot(dropOff(1.5, 0.9), { deviceAim: 'too-low' }),
    );
    expect(run(frames).active).toBeNull();
  });

  it('ignores hazards beyond the announce range', () => {
    const frames = Array.from({ length: 6 }, () =>
      snapshot(dropOff(GROUND_HAZARDS.maximumAnnounceDistanceM + 0.5, 0.9)),
    );
    expect(run(frames).active).toBeNull();
  });

  it('holds the alert briefly, then clears after enough clear frames', () => {
    const confirmed = run(
      Array.from({ length: GROUND_HAZARDS.framesToConfirmDropOff }, () =>
        snapshot(dropOff(2, 0.8)),
      ),
    );

    const stillHeld = run(
      Array.from({ length: GROUND_HAZARDS.framesToClear - 1 }, () =>
        snapshot(undefined, {}),
      ),
      confirmed,
    );
    expect(stillHeld.active).toBe('drop-off');

    const cleared = reduceGroundHazardState(stillHeld, snapshot(undefined, {}));
    expect(cleared.active).toBeNull();
    expect(cleared.lastSpokenPhrase).toBeNull();
  });

  it('handles snapshots without a hazards field (older native module)', () => {
    const state = run(
      Array.from({ length: 6 }, () => snapshot(undefined, {})),
    );
    expect(state).toEqual(INITIAL_GROUND_HAZARD_STATE);
  });
});

describe('groundHazardRisk', () => {
  it('maps hazards onto the shared risk scale', () => {
    expect(groundHazardRisk(INITIAL_GROUND_HAZARD_STATE)).toBe('clear');
    expect(
      groundHazardRisk({
        ...INITIAL_GROUND_HAZARD_STATE,
        active: 'drop-off',
        distanceM: 1.0,
      }),
    ).toBe('critical');
    expect(
      groundHazardRisk({
        ...INITIAL_GROUND_HAZARD_STATE,
        active: 'drop-off',
        distanceM: 2.5,
      }),
    ).toBe('near');
    expect(
      groundHazardRisk({
        ...INITIAL_GROUND_HAZARD_STATE,
        active: 'trip-hazard',
        distanceM: 1.0,
      }),
    ).toBe('near');
    expect(
      groundHazardRisk({
        ...INITIAL_GROUND_HAZARD_STATE,
        active: 'trip-hazard',
        distanceM: 2.5,
      }),
    ).toBe('caution');
  });
});

describe('escalateRisk', () => {
  it('returns the more urgent of two risks', () => {
    expect(escalateRisk('clear', 'near')).toBe('near');
    expect(escalateRisk('critical', 'caution')).toBe('critical');
    expect(escalateRisk('unknown', 'clear')).toBe('clear');
  });
});
