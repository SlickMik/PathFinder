export type OnboardingStep = {
  key: string;
  title: string;
  body: string;
};

/**
 * The guided tour is written to be listened to, not read: every step is
 * spoken aloud through the same speech channel the scanner uses, so the
 * onboarding also demonstrates how alerts will sound.
 */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    key: 'welcome',
    title: 'Welcome to PathFinder',
    body:
      'PathFinder is a supplemental navigation aid. It uses the LiDAR sensor ' +
      'on the back of your phone to feel the space up to about five metres ' +
      'ahead and warns you about obstacles with vibration and speech. It is ' +
      'an extra pair of eyes, never a replacement for your cane, your guide ' +
      'dog, or your own judgment.',
  },
  {
    key: 'hold',
    title: 'How to hold your phone',
    body:
      'Hold the phone upright at chest height, with the back camera pointing ' +
      'straight ahead, like a torch lighting your path. If the phone tilts ' +
      'too far up or down, PathFinder pauses and tells you to reposition it. ' +
      'You never need to look at the screen.',
  },
  {
    key: 'start-stop',
    title: 'Start and stop scanning',
    body:
      'The large button near the top of the screen starts and stops obstacle ' +
      'alerts. PathFinder speaks a confirmation when scanning starts and ' +
      'stops. While scanning, the screen stays awake. Scanning stops on its ' +
      'own if the app goes to the background or the phone gets too warm.',
  },
  {
    key: 'alerts',
    title: 'Feel and hear the warnings',
    body:
      'Vibration is your main warning. Gentle occasional taps mean caution. ' +
      'Strong taps mean an obstacle is near. A rapid buzz means stop now. ' +
      'Speech tells you which side the obstacle is on, for example, obstacle ' +
      'left. If you hear, very close, stop, stop moving immediately.',
  },
  {
    key: 'guidance',
    title: 'Follow route guidance',
    body:
      'While you walk, PathFinder speaks short steering cues such as go ' +
      'straight, go slightly left, or stop. In a narrow opening it tells you ' +
      'to keep centred. Guidance only covers the next few metres it can ' +
      'actually see. It cannot plan a route through a building.',
  },
  {
    key: 'voice',
    title: 'Talk to PathFinder',
    body:
      'Turn on companion mode to talk with PathFinder like a friend. Walk ' +
      'and talk keeps a hands-free conversation going while you move, or ' +
      'hold to talk to ask a single question, like, what is around me. The ' +
      'describe scene button speaks one description of what the camera sees. ' +
      'A camera picture is only sent when you ask for a description or an ' +
      'answer, and obstacle alerts keep running the whole time.',
  },
  {
    key: 'safety',
    title: 'Practice safely first',
    body:
      'Practice in a familiar room with a sighted friend before relying on ' +
      'any alert. PathFinder can miss glass, water, stairs, drop-offs, and ' +
      'fast-moving people. Keep using your cane, guide dog, and training at ' +
      'all times. You can replay this guide any time from the how to use ' +
      'PathFinder button on the main screen.',
  },
];

export const ONBOARDING_STEP_COUNT = ONBOARDING_STEPS.length;

export function clampStepIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), ONBOARDING_STEP_COUNT - 1);
}

export function isFirstStep(index: number): boolean {
  return clampStepIndex(index) === 0;
}

export function isLastStep(index: number): boolean {
  return clampStepIndex(index) === ONBOARDING_STEP_COUNT - 1;
}

/** Full spoken script for a step, including its position in the tour. */
export function spokenTextForStep(index: number): string {
  const clamped = clampStepIndex(index);
  const step = ONBOARDING_STEPS[clamped];
  return `Step ${clamped + 1} of ${ONBOARDING_STEP_COUNT}. ${step.title}. ${step.body}`;
}
