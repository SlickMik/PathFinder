import {
  ONBOARDING_STEPS,
  ONBOARDING_STEP_COUNT,
  clampStepIndex,
  isFirstStep,
  isLastStep,
  spokenTextForStep,
} from '../features/onboarding/steps';

describe('onboarding steps content', () => {
  it('has a usable multi-step tour', () => {
    expect(ONBOARDING_STEP_COUNT).toBeGreaterThanOrEqual(5);
    expect(ONBOARDING_STEPS).toHaveLength(ONBOARDING_STEP_COUNT);
  });

  it('gives every step a unique key, a title, and a spoken body', () => {
    const keys = new Set<string>();
    for (const step of ONBOARDING_STEPS) {
      expect(step.key.length).toBeGreaterThan(0);
      expect(keys.has(step.key)).toBe(false);
      keys.add(step.key);
      expect(step.title.length).toBeGreaterThan(0);
      // Bodies must be real spoken guidance, not placeholders.
      expect(step.body.length).toBeGreaterThan(80);
    }
  });

  it('opens with the safety boundary and closes with safe practice', () => {
    expect(ONBOARDING_STEPS[0].body).toMatch(/never a replacement/i);
    expect(ONBOARDING_STEPS[ONBOARDING_STEP_COUNT - 1].body).toMatch(
      /cane, guide dog/i,
    );
  });
});

describe('step navigation', () => {
  it('clamps indices to the valid range', () => {
    expect(clampStepIndex(-3)).toBe(0);
    expect(clampStepIndex(0)).toBe(0);
    expect(clampStepIndex(2.9)).toBe(2);
    expect(clampStepIndex(ONBOARDING_STEP_COUNT + 5)).toBe(
      ONBOARDING_STEP_COUNT - 1,
    );
    expect(clampStepIndex(Number.NaN)).toBe(0);
  });

  it('identifies the first and last steps', () => {
    expect(isFirstStep(0)).toBe(true);
    expect(isFirstStep(1)).toBe(false);
    expect(isLastStep(ONBOARDING_STEP_COUNT - 1)).toBe(true);
    expect(isLastStep(0)).toBe(false);
    // Out-of-range indices resolve to the clamped step.
    expect(isFirstStep(-2)).toBe(true);
    expect(isLastStep(99)).toBe(true);
  });

  it('speaks the step position, title, and body', () => {
    const spoken = spokenTextForStep(0);
    expect(spoken).toContain(`Step 1 of ${ONBOARDING_STEP_COUNT}`);
    expect(spoken).toContain(ONBOARDING_STEPS[0].title);
    expect(spoken).toContain(ONBOARDING_STEPS[0].body);
    // Out-of-range requests fall back to a valid step instead of crashing.
    expect(spokenTextForStep(99)).toContain(
      ONBOARDING_STEPS[ONBOARDING_STEP_COUNT - 1].title,
    );
  });
});
