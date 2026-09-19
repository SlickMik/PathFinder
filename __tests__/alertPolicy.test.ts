import {
  INITIAL_ALERT_STATE,
  dominantSector,
  reduceAlertState,
  riskForReading,
} from '../features/scanning/alertPolicy';
import type { ObstacleSnapshot, SectorReading } from '../features/scanning/types';

const reliable = (distanceM: number | null): SectorReading => ({
  distanceM,
  confidence: 'high',
  coverage: 0.8,
});

const snapshot = (
  risk: ObstacleSnapshot['corridor']['risk'],
  distanceM: number | null,
): ObstacleSnapshot => ({
  timestampMs: 1,
  tracking: 'normal',
  deviceAim: 'forward',
  motion: { speedMps: 0 },
  left: reliable(2.8),
  center: reliable(distanceM),
  right: reliable(2.9),
  corridor: {
    distanceM,
    timeToContactS: null,
    coverage: 0.8,
    risk,
  },
});

describe('riskForReading', () => {
  it.each([
    [0.59, 'critical'],
    [0.6, 'near'],
    [1.19, 'near'],
    [1.2, 'caution'],
    [2, 'caution'],
    [2.01, 'clear'],
  ] as const)('maps %s metres to %s', (distance, expected) => {
    expect(riskForReading(reliable(distance))).toBe(expected);
  });

  it('treats an empty but well-covered sector as clear', () => {
    expect(riskForReading(reliable(null))).toBe('clear');
  });

  it('never treats low coverage as clear', () => {
    expect(
      riskForReading({ distanceM: null, confidence: 'high', coverage: 0.1 }),
    ).toBe('unknown');
  });
});

describe('dominantSector', () => {
  it('prefers the center when equal risks and distances tie', () => {
    const reading = reliable(0.9);
    const value = snapshot('near', 0.9);
    value.left = reading;
    value.center = reading;
    value.right = reading;
    expect(dominantSector(value)).toBe('center');
  });

  it('chooses the highest-risk reliable sector', () => {
    const value = snapshot('critical', 0.4);
    value.left = reliable(0.4);
    value.center = reliable(0.9);
    expect(dominantSector(value)).toBe('left');
  });
});

describe('reduceAlertState', () => {
  it('enters a more urgent state immediately', () => {
    const next = reduceAlertState(INITIAL_ALERT_STATE, snapshot('critical', 0.4));
    expect(next.risk).toBe('critical');
    expect(next.announcement).toBe('Very close. Stop.');
  });

  it('requires four consistently safer frames before exiting danger', () => {
    let state = reduceAlertState(INITIAL_ALERT_STATE, snapshot('near', 0.9));
    for (let index = 0; index < 3; index += 1) {
      state = reduceAlertState(state, snapshot('clear', null));
      expect(state.risk).toBe('near');
    }
    state = reduceAlertState(state, snapshot('clear', null));
    expect(state.risk).toBe('clear');
  });

  it('pauses after three invalid view frames', () => {
    let state = reduceAlertState(INITIAL_ALERT_STATE, snapshot('near', 0.9));
    const invalid = snapshot('near', 0.9);
    invalid.deviceAim = 'too-high';
    state = reduceAlertState(state, invalid);
    state = reduceAlertState(state, invalid);
    expect(state.risk).toBe('near');
    state = reduceAlertState(state, invalid);
    expect(state.risk).toBe('unknown');
    expect(state.announcement).toBe('View blocked. Reposition phone.');
  });
});
