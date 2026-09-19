import { hapticIntervalMs } from '../features/scanning/haptics';

describe('hapticIntervalMs', () => {
  it('increases cadence with urgency', () => {
    expect(hapticIntervalMs('critical')).toBeLessThan(hapticIntervalMs('near')!);
    expect(hapticIntervalMs('near')).toBeLessThan(hapticIntervalMs('caution')!);
  });

  it('stays silent for clear and unknown readings', () => {
    expect(hapticIntervalMs('clear')).toBeNull();
    expect(hapticIntervalMs('unknown')).toBeNull();
  });
});
