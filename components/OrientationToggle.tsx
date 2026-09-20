import { Pressable, StyleSheet, Text, View } from 'react-native';

export type AppOrientation = 'portrait' | 'landscape';

type Props = {
  disabled?: boolean;
  onChange: (orientation: AppOrientation) => void;
  value: AppOrientation;
};

export function OrientationToggle({ disabled = false, onChange, value }: Props) {
  return (
    <View
      accessibilityLabel={`Screen orientation. ${value} selected.`}
      accessibilityRole="radiogroup"
      style={styles.container}
    >
      <Text maxFontSizeMultiplier={1.6} style={styles.label}>
        SCREEN
      </Text>
      <View style={styles.options}>
        <OrientationOption
          disabled={disabled}
          label="Vertical"
          onPress={() => onChange('portrait')}
          orientation="portrait"
          selected={value === 'portrait'}
        />
        <OrientationOption
          disabled={disabled}
          label="Horizontal"
          onPress={() => onChange('landscape')}
          orientation="landscape"
          selected={value === 'landscape'}
        />
      </View>
    </View>
  );
}

function OrientationOption({
  disabled,
  label,
  onPress,
  orientation,
  selected,
}: {
  disabled: boolean;
  label: string;
  onPress: () => void;
  orientation: AppOrientation;
  selected: boolean;
}) {
  return (
    <Pressable
      accessibilityHint={`Locks the app in ${label.toLowerCase()} orientation.`}
      accessibilityLabel={label}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.option,
        selected && styles.optionSelected,
        pressed && !disabled && styles.optionPressed,
        disabled && styles.optionDisabled,
      ]}
    >
      <View
        accessibilityElementsHidden
        style={[
          styles.device,
          orientation === 'portrait' ? styles.devicePortrait : styles.deviceLandscape,
          selected && styles.deviceSelected,
        ]}
      >
        <View style={[styles.deviceLine, selected && styles.deviceLineSelected]} />
      </View>
      <Text maxFontSizeMultiplier={1.5} style={[styles.optionText, selected && styles.optionTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    minHeight: 66,
    borderRadius: 20,
    padding: 6,
    paddingLeft: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: 'rgba(14, 19, 24, 0.92)',
    borderWidth: 1,
    borderColor: '#313A45',
  },
  label: {
    color: '#AAB3BF',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '900',
    letterSpacing: 1.4,
  },
  options: {
    flex: 1,
    flexDirection: 'row',
    gap: 4,
  },
  option: {
    flex: 1,
    minHeight: 52,
    borderRadius: 15,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  optionSelected: {
    backgroundColor: '#F4FF72',
    borderColor: '#F4FF72',
  },
  optionPressed: {
    opacity: 0.72,
  },
  optionDisabled: {
    opacity: 0.5,
  },
  optionText: {
    color: '#CFD5DD',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '800',
  },
  optionTextSelected: {
    color: '#0A0D10',
  },
  device: {
    borderWidth: 2,
    borderColor: '#AAB3BF',
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 2,
  },
  devicePortrait: {
    width: 14,
    height: 21,
  },
  deviceLandscape: {
    width: 22,
    height: 15,
  },
  deviceSelected: {
    borderColor: '#0A0D10',
  },
  deviceLine: {
    width: 5,
    height: 2,
    borderRadius: 1,
    backgroundColor: '#AAB3BF',
  },
  deviceLineSelected: {
    backgroundColor: '#0A0D10',
  },
});
