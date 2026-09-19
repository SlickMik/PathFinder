import { StyleSheet, Text, View } from 'react-native';
import { riskForReading } from '../features/scanning/alertPolicy';
import type { Sector, SectorReading } from '../features/scanning/types';

type Props = {
  sector: Sector;
  reading: SectorReading | null;
  active: boolean;
};

const RISK_STYLE = {
  clear: { background: '#1A3A2B', border: '#3B8C62', text: 'Clear range' },
  caution: { background: '#443D17', border: '#BCA63F', text: 'Caution' },
  near: { background: '#54301B', border: '#E98B45', text: 'Near' },
  critical: { background: '#561E20', border: '#FF6B66', text: 'Critical' },
  unknown: { background: '#20252C', border: '#48515E', text: 'Unknown' },
} as const;

export function SectorStatus({ sector, reading, active }: Props) {
  const risk = reading && active ? riskForReading(reading) : 'unknown';
  const presentation = RISK_STYLE[risk];
  const distance = reading?.distanceM;
  const distanceLabel =
    active && distance !== null && distance !== undefined
      ? `${distance.toFixed(1)} m`
      : '—';

  return (
    <View
      accessible
      accessibilityLabel={`${sector}. ${presentation.text}. ${distanceLabel}`}
      style={[
        styles.card,
        { backgroundColor: presentation.background, borderColor: presentation.border },
      ]}
    >
      <Text maxFontSizeMultiplier={1.5} style={styles.sector}>
        {sector.toUpperCase()}
      </Text>
      <Text maxFontSizeMultiplier={1.4} style={styles.distance}>
        {distanceLabel}
      </Text>
      <Text maxFontSizeMultiplier={1.4} style={styles.risk}>
        {presentation.text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    minHeight: 124,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 15,
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sector: {
    color: '#CAD0D8',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800',
    letterSpacing: 1.1,
  },
  distance: {
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
    fontSize: 25,
    lineHeight: 31,
    fontWeight: '800',
  },
  risk: {
    color: '#F2F4F7',
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
});
