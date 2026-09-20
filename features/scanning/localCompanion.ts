import { surfacePhrase } from './navigation';
import type { AlertState, NavigationGuidance, ObstacleSnapshot, SectorReading } from './types';

function metres(distance: number): string {
  const rounded = Math.round(distance * 10) / 10;
  return rounded === 1 ? 'about one metre' : `about ${rounded} metres`;
}

function usableDistance(reading: SectorReading): number | null {
  return reading.distanceM !== null && reading.coverage >= 0.3 ? reading.distanceM : null;
}

function directionReading(text: string, snapshot: ObstacleSnapshot) {
  if (/\bleft\b/.test(text)) return { reading: snapshot.left, place: 'on your left' };
  if (/\bright\b/.test(text)) return { reading: snapshot.right, place: 'on your right' };
  return { reading: snapshot.center, place: 'ahead' };
}

export function needsVisualContext(text: string): boolean {
  return /\b(see|look|scene|surroundings?|around|ahead|in front|person|people|who|color|sign|read|door|vehicle|car|building|store|object|this|that|there)\b/i.test(
    text,
  );
}

// Answer only narrow, high-confidence sensor questions locally. Everything
// semantic or ambiguous falls through to Gemini with a single camera frame.
export function localSensorReply(
  text: string,
  snapshot: ObstacleSnapshot | null,
  alert: AlertState,
  guidance: NavigationGuidance,
): string | null {
  if (!snapshot) return null;
  const normalized = text.toLowerCase();

  if (/\b(how far|how close|distance)\b/.test(normalized)) {
    const { reading, place } = directionReading(normalized, snapshot);
    const distance = usableDistance(reading);
    return distance === null
      ? `I can't get a reliable distance ${place} right now.`
      : `The nearest depth return ${place} is ${metres(distance)} away.`;
  }

  if (/\b(which way|what direction|where should i go|guide me|navigate)\b/.test(normalized)) {
    if (guidance.instruction === 'hold' || !guidance.phrase) {
      return "I don't have a reliable direction yet. Keep the phone upright and pointed forward.";
    }
    if (guidance.instruction === 'stop') {
      return "Stop. The local sensors can't confirm an open route yet.";
    }
    const surface = surfacePhrase(guidance.surfaceClass);
    const clearance =
      guidance.clearanceM === null ? null : ` I read ${metres(guidance.clearanceM)} of clearance.`;
    return `${guidance.phrase}${surface ? ` ${surface}` : ''}${clearance ?? ''}`;
  }

  if (/\b(surface|sidewalk|crosswalk|curb cut|walking on|ground)\b/.test(normalized)) {
    return (
      surfacePhrase(guidance.surfaceClass) ??
      "The on-device path model hasn't identified the walking surface yet."
    );
  }

  if (/\b(is there|are there)\b.*\b(obstacle|something in (front|my way))\b/.test(normalized)) {
    if (alert.announcement) return alert.announcement;
    const distance = snapshot.corridor.distanceM;
    return distance === null
      ? "I don't have a reliable corridor reading right now."
      : `The nearest depth return in your walking corridor is ${metres(distance)} away.`;
  }

  return null;
}

export function localSceneFallback(
  snapshot: ObstacleSnapshot | null,
  alert: AlertState,
  guidance: NavigationGuidance,
): string {
  const facts: string[] = [];
  if ((alert.risk === 'near' || alert.risk === 'critical') && alert.announcement) {
    facts.push(alert.announcement);
  }
  if (guidance.phrase && guidance.instruction !== 'hold') facts.push(guidance.phrase);
  const surface = surfacePhrase(guidance.surfaceClass);
  if (surface) facts.push(surface);
  if (facts.length === 0 && snapshot) {
    const distance = usableDistance(snapshot.center);
    if (distance !== null) facts.push(`The nearest depth return ahead is ${metres(distance)} away.`);
  }
  return facts.length > 0
    ? facts.join(' ')
    : "Local obstacle scanning is active, but I can't identify the wider scene without Gemini.";
}
