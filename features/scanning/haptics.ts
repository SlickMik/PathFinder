import * as Haptics from 'expo-haptics';
import type { Risk } from './types';

export function hapticIntervalMs(risk: Risk): number | null {
  switch (risk) {
    case 'critical':
      return 280;
    case 'near':
      return 650;
    case 'caution':
      return 1500;
    default:
      return null;
  }
}

export async function emitRiskHaptic(risk: Risk): Promise<void> {
  try {
    switch (risk) {
      case 'critical':
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      case 'near':
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        return;
      case 'caution':
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        return;
      default:
        return;
    }
  } catch {
    // Haptics are supplementary; sensor processing must continue if unavailable.
  }
}
