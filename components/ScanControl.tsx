import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ScannerStatus } from '../features/scanning/types';

type Props = {
  active: boolean;
  disabled: boolean;
  status: ScannerStatus;
  onPress: () => void;
};

export function ScanControl({ active, disabled, status, onPress }: Props) {
  const busy = status === 'checking' || status === 'starting';
  const label = active ? 'Stop obstacle alerts' : busy ? 'Checking LiDAR…' : 'Start obstacle alerts';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={
        active
          ? 'Stops LiDAR scanning and all repeating haptic alerts.'
          : 'Starts local LiDAR obstacle scanning.'
      }
      accessibilityState={{ disabled, busy, expanded: active }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        active ? styles.stopButton : styles.startButton,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <View style={[styles.icon, active ? styles.stopIcon : styles.startIcon]} />
      <Text maxFontSizeMultiplier={1.6} style={styles.label}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 68,
    borderRadius: 18,
    paddingHorizontal: 20,
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    borderWidth: 2,
  },
  startButton: {
    backgroundColor: '#F2FF63',
    borderColor: '#F2FF63',
  },
  stopButton: {
    backgroundColor: '#FF5D55',
    borderColor: '#FF8C86',
  },
  disabled: {
    opacity: 0.46,
  },
  pressed: {
    transform: [{ scale: 0.985 }],
  },
  icon: {
    width: 20,
    height: 20,
  },
  startIcon: {
    borderRadius: 12,
    backgroundColor: '#0B0D10',
    borderWidth: 6,
    borderColor: '#0B0D10',
  },
  stopIcon: {
    borderRadius: 4,
    backgroundColor: '#0B0D10',
  },
  label: {
    color: '#0B0D10',
    fontSize: 19,
    lineHeight: 24,
    fontWeight: '800',
    textAlign: 'center',
  },
});
