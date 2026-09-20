import {
  localSceneFallback,
  localSensorReply,
  needsVisualContext,
} from '../features/scanning/localCompanion';
import { INITIAL_ALERT_STATE } from '../features/scanning/alertPolicy';
import { INITIAL_NAVIGATION_GUIDANCE } from '../features/scanning/navigation';
import type { ObstacleSnapshot } from '../features/scanning/types';

const snapshot: ObstacleSnapshot = {
  timestampMs: Date.now(),
  tracking: 'normal',
  deviceAim: 'forward',
  motion: { speedMps: 0 },
  left: { distanceM: 2.4, confidence: 'high', coverage: 0.9 },
  center: { distanceM: 1.3, confidence: 'high', coverage: 0.9 },
  right: { distanceM: 3, confidence: 'medium', coverage: 0.8 },
  corridor: { distanceM: 1.3, timeToContactS: null, coverage: 0.9, risk: 'near' },
};

describe('local companion routing', () => {
  it('answers reliable distance questions without the cloud', () => {
    expect(
      localSensorReply(
        'How far is the obstacle on my left?',
        snapshot,
        INITIAL_ALERT_STATE,
        INITIAL_NAVIGATION_GUIDANCE,
      ),
    ).toBe('The nearest depth return on your left is about 2.4 metres away.');
  });

  it('leaves semantic scene questions for Gemini', () => {
    expect(
      localSensorReply(
        'What does the street around me look like?',
        snapshot,
        INITIAL_ALERT_STATE,
        INITIAL_NAVIGATION_GUIDANCE,
      ),
    ).toBeNull();
    expect(needsVisualContext('What does the street around me look like?')).toBe(true);
    expect(needsVisualContext('Tell me a joke')).toBe(false);
  });

  it('builds an offline scene fallback from route facts', () => {
    expect(
      localSceneFallback(snapshot, INITIAL_ALERT_STATE, {
        ...INITIAL_NAVIGATION_GUIDANCE,
        instruction: 'slight-left',
        phrase: 'Go slightly left.',
        surfaceClass: 'sidewalk',
      }),
    ).toBe('Go slightly left. Sidewalk ahead.');
  });
});
