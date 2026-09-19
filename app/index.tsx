import { ScanControl } from '../components/ScanControl';
import { SectorStatus } from '../components/SectorStatus';
import { StatusAnnouncement } from '../components/StatusAnnouncement';
import { useLidarScanner } from '../features/scanning/useLidarScanner';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const RISK_COPY = {
  unknown: ['WAITING', 'No reliable corridor reading'],
  clear: ['OPEN RANGE', 'No nearby corridor obstacle detected'],
  caution: ['CAUTION', 'Obstacle within 2 metres'],
  near: ['NEAR', 'Obstacle within 1.2 metres'],
  critical: ['STOP', 'Obstacle is very close'],
} as const;

export default function ScannerScreen() {
  const scanner = useLidarScanner();
  const riskCopy = RISK_COPY[scanner.active ? scanner.alert.risk : 'unknown'];
  const unsupported = scanner.status === 'unsupported';
  const busy = scanner.status === 'checking' || scanner.status === 'starting';
  const snapshot = scanner.snapshot;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        alwaysBounceVertical={false}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View style={styles.mark} accessibilityElementsHidden>
            <View style={styles.markLineShort} />
            <View style={styles.markLineTall} />
            <View style={styles.markLineShort} />
          </View>
          <View style={styles.headerCopy}>
            <Text maxFontSizeMultiplier={1.5} style={styles.eyebrow}>
              PATHFINDER
            </Text>
            <Text maxFontSizeMultiplier={1.5} style={styles.title}>
              Obstacle alerts
            </Text>
          </View>
        </View>

        <StatusAnnouncement
          deviceAim={snapshot?.deviceAim}
          errorMessage={scanner.errorMessage}
          status={scanner.status}
          tracking={snapshot?.tracking}
        />

        <View
          accessible
          accessibilityRole="alert"
          accessibilityLabel={`${riskCopy[0]}. ${riskCopy[1]}.`}
          style={[
            styles.riskPanel,
            scanner.alert.risk === 'critical' && scanner.active && styles.criticalPanel,
          ]}
        >
          <Text maxFontSizeMultiplier={1.6} style={styles.riskLabel}>
            {riskCopy[0]}
          </Text>
          <Text maxFontSizeMultiplier={1.6} style={styles.riskDetail}>
            {riskCopy[1]}
          </Text>
          {scanner.active && snapshot?.corridor.timeToContactS != null ? (
            <Text maxFontSizeMultiplier={1.5} style={styles.ttc}>
              Estimated contact in {snapshot.corridor.timeToContactS.toFixed(1)} seconds
            </Text>
          ) : null}
        </View>

        <View style={styles.sectionHeader}>
          <Text maxFontSizeMultiplier={1.6} style={styles.sectionTitle}>
            Forward sectors
          </Text>
          <Text maxFontSizeMultiplier={1.4} style={styles.sectionMeta}>
            LOCAL · 10 HZ
          </Text>
        </View>

        <View style={styles.sectors}>
          <SectorStatus active={scanner.active} reading={snapshot?.left ?? null} sector="left" />
          <SectorStatus active={scanner.active} reading={snapshot?.center ?? null} sector="center" />
          <SectorStatus active={scanner.active} reading={snapshot?.right ?? null} sector="right" />
        </View>

        <ScanControl
          active={scanner.active}
          disabled={unsupported || busy}
          onPress={() => (scanner.active ? void scanner.stop() : void scanner.start())}
          status={scanner.status}
        />

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Describe scene"
          accessibilityHint="Sends one camera frame for a spoken description."
          disabled={!scanner.active}
          onPress={() => void scanner.describeScene()}
          style={[styles.describe, !scanner.active && styles.describeDisabled]}
        >
          <Text maxFontSizeMultiplier={1.6} style={styles.describeText}>
            Describe scene
          </Text>
        </Pressable>

        <View style={styles.safetyNote}>
          <Text maxFontSizeMultiplier={2} style={styles.safetyTitle}>
            Supplemental aid only
          </Text>
          <Text maxFontSizeMultiplier={2} style={styles.safetyBody}>
            Keep using your cane, guide dog, training, and judgment. PathFinder cannot confirm
            that a route, stair, drop-off, glass surface, or crossing is safe.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0B0D10',
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 36,
    gap: 18,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 2,
  },
  mark: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: '#F2FF63',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  markLineShort: {
    width: 4,
    height: 15,
    borderRadius: 2,
    backgroundColor: '#0B0D10',
  },
  markLineTall: {
    width: 4,
    height: 27,
    borderRadius: 2,
    backgroundColor: '#0B0D10',
  },
  headerCopy: {
    flex: 1,
  },
  eyebrow: {
    color: '#F2FF63',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '900',
    letterSpacing: 2.3,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
    letterSpacing: -0.7,
  },
  riskPanel: {
    minHeight: 150,
    borderRadius: 20,
    backgroundColor: '#171B21',
    borderWidth: 1,
    borderColor: '#303742',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  criticalPanel: {
    backgroundColor: '#561E20',
    borderColor: '#FF6B66',
    borderWidth: 2,
  },
  riskLabel: {
    color: '#FFFFFF',
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '900',
    letterSpacing: 1.8,
    textAlign: 'center',
  },
  riskDetail: {
    color: '#C7CDD5',
    fontSize: 16,
    lineHeight: 23,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 5,
  },
  ttc: {
    color: '#FFFFFF',
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '700',
    marginTop: 10,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginTop: 2,
  },
  sectionTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    lineHeight: 23,
    fontWeight: '800',
  },
  sectionMeta: {
    color: '#8E97A3',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '800',
    letterSpacing: 1.1,
  },
  sectors: {
    flexDirection: 'row',
    gap: 8,
  },
  describe: {
    minHeight: 56,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#B8C147',
    alignItems: 'center',
    justifyContent: 'center',
  },
  describeDisabled: {
    opacity: 0.4,
  },
  describeText: {
    color: '#F2FF63',
    fontSize: 18,
    fontWeight: '800',
  },
  safetyNote: {
    borderTopWidth: 1,
    borderTopColor: '#2B3038',
    paddingTop: 17,
    gap: 5,
  },
  safetyTitle: {
    color: '#DCE1E8',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '800',
  },
  safetyBody: {
    color: '#8E97A3',
    fontSize: 13,
    lineHeight: 20,
    fontWeight: '500',
  },
});
