import { ScanControl } from '../components/ScanControl';
import { SectorStatus } from '../components/SectorStatus';
import { StatusAnnouncement } from '../components/StatusAnnouncement';
import { useLidarScanner } from '../features/scanning/useLidarScanner';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const RISK_LABEL = {
  unknown: 'WAITING',
  clear: 'OPEN RANGE',
  caution: 'CAUTION',
  near: 'NEAR',
  critical: 'STOP',
} as const;

const GUIDANCE_LABEL = {
  hold: 'HOLD POSITION',
  stop: 'STOP',
  straight: 'GO STRAIGHT',
  'slight-left': 'GO SLIGHTLY LEFT',
  left: 'GO LEFT',
  'slight-right': 'GO SLIGHTLY RIGHT',
  right: 'GO RIGHT',
} as const;

export default function ScannerScreen() {
  const scanner = useLidarScanner();
  const visibleRisk = scanner.active ? scanner.alert.risk : 'unknown';
  const riskLabel = RISK_LABEL[visibleRisk];
  const riskDetail =
    visibleRisk === 'unknown'
      ? 'No reliable corridor reading'
      : visibleRisk === 'clear'
        ? 'No nearby corridor obstacle detected'
        : visibleRisk === 'critical'
          ? 'Obstacle is very close'
          : `Dynamic warning range: ${scanner.safetyEnvelope.warningDistanceM.toFixed(1)} metres`;
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

        <View style={styles.cameraPanel}>
          <View style={styles.cameraHeader}>
            <View>
              <Text maxFontSizeMultiplier={1.5} style={styles.cameraEyebrow}>
                CAMERA TEST
              </Text>
              <Text
                accessibilityLiveRegion="polite"
                maxFontSizeMultiplier={1.5}
                style={styles.cameraStatus}
              >
                {scanner.cameraTestBusy
                  ? 'CAPTURING…'
                  : scanner.cameraTestFrame
                    ? 'CAMERA READY'
                    : scanner.active
                      ? 'READY TO TEST'
                      : 'START SCANNING FIRST'}
              </Text>
            </View>
            <View
              style={[
                styles.cameraIndicator,
                scanner.cameraTestFrame && styles.cameraIndicatorReady,
              ]}
            />
          </View>

          {scanner.cameraTestFrame ? (
            <Image
              accessibilityIgnoresInvertColors
              resizeMode="cover"
              source={{ uri: scanner.cameraTestFrame.uri }}
              style={styles.cameraPreview}
            />
          ) : (
            <View style={styles.cameraPlaceholder}>
              <Text maxFontSizeMultiplier={1.5} style={styles.cameraPlaceholderText}>
                Camera preview appears here
              </Text>
            </View>
          )}

          {scanner.cameraTestError ? (
            <Text accessibilityRole="alert" style={styles.cameraError}>
              {scanner.cameraTestError}
            </Text>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Test camera"
            accessibilityHint="Captures and displays the current ARKit camera frame."
            disabled={!scanner.active || scanner.cameraTestBusy}
            onPress={() => void scanner.testCamera()}
            style={({ pressed }) => [
              styles.cameraButton,
              (!scanner.active || scanner.cameraTestBusy) && styles.cameraButtonDisabled,
              pressed && scanner.active && styles.cameraButtonPressed,
            ]}
          >
            <Text style={styles.cameraButtonText}>
              {scanner.cameraTestBusy ? 'Capturing…' : 'Capture test frame'}
            </Text>
          </Pressable>
        </View>

        <StatusAnnouncement
          deviceAim={snapshot?.deviceAim}
          errorMessage={scanner.errorMessage}
          status={scanner.status}
          tracking={snapshot?.tracking}
        />

        <View
          accessible
          accessibilityRole="summary"
          accessibilityLabel={`Guidance: ${GUIDANCE_LABEL[scanner.guidance.instruction]}. Moving ${scanner.safetyEnvelope.speedMps.toFixed(1)} metres per second. Warning distance ${scanner.safetyEnvelope.warningDistanceM.toFixed(1)} metres.`}
          style={styles.guidancePanel}
        >
          <Text maxFontSizeMultiplier={1.6} style={styles.guidanceEyebrow}>
            ROUTE GUIDANCE
          </Text>
          <Text maxFontSizeMultiplier={1.5} style={styles.guidanceText}>
            {scanner.active ? GUIDANCE_LABEL[scanner.guidance.instruction] : 'READY'}
          </Text>
          <View style={styles.motionRow}>
            <Text maxFontSizeMultiplier={1.4} style={styles.motionMetric}>
              SPEED {scanner.safetyEnvelope.speedMps.toFixed(1)} M/S
            </Text>
            <Text maxFontSizeMultiplier={1.4} style={styles.motionMetric}>
              WARN {scanner.safetyEnvelope.warningDistanceM.toFixed(1)} M
            </Text>
          </View>
          {scanner.active && scanner.guidance.isNarrowOpening ? (
            <Text maxFontSizeMultiplier={1.5} style={styles.narrowOpening}>
              NARROW OPENING · KEEP CENTERED
              {scanner.guidance.openingWidthM != null
                ? ` · ${scanner.guidance.openingWidthM.toFixed(1)} M`
                : ''}
            </Text>
          ) : null}
        </View>

        <View
          accessible
          accessibilityRole="alert"
          accessibilityLabel={`${riskLabel}. ${riskDetail}.`}
          style={[
            styles.riskPanel,
            scanner.alert.risk === 'critical' && scanner.active && styles.criticalPanel,
          ]}
        >
          <Text maxFontSizeMultiplier={1.6} style={styles.riskLabel}>
            {riskLabel}
          </Text>
          <Text maxFontSizeMultiplier={1.6} style={styles.riskDetail}>
            {riskDetail}
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
  cameraPanel: {
    borderRadius: 20,
    backgroundColor: '#171B21',
    borderWidth: 1,
    borderColor: '#303742',
    padding: 14,
    gap: 12,
  },
  cameraHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cameraEyebrow: {
    color: '#8E97A3',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '900',
    letterSpacing: 1.5,
  },
  cameraStatus: {
    color: '#FFFFFF',
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '800',
  },
  cameraIndicator: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#657080',
  },
  cameraIndicatorReady: {
    backgroundColor: '#F2FF63',
  },
  cameraPreview: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 14,
    backgroundColor: '#090A0C',
  },
  cameraPlaceholder: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 14,
    backgroundColor: '#090A0C',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraPlaceholderText: {
    color: '#727B87',
    fontSize: 14,
    fontWeight: '600',
  },
  cameraError: {
    color: '#FF8D88',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  cameraButton: {
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: '#F2FF63',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraButtonDisabled: {
    opacity: 0.4,
  },
  cameraButtonPressed: {
    opacity: 0.8,
  },
  cameraButtonText: {
    color: '#0B0D10',
    fontSize: 16,
    fontWeight: '900',
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
  guidancePanel: {
    borderRadius: 20,
    backgroundColor: '#F2FF63',
    paddingHorizontal: 22,
    paddingVertical: 19,
    gap: 5,
  },
  guidanceEyebrow: {
    color: '#353A09',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '900',
    letterSpacing: 1.5,
  },
  guidanceText: {
    color: '#0B0D10',
    fontSize: 29,
    lineHeight: 35,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  motionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 4,
  },
  motionMetric: {
    color: '#353A09',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  narrowOpening: {
    color: '#0B0D10',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '900',
    letterSpacing: 0.5,
    marginTop: 4,
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
