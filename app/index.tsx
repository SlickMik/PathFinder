import { ScanControl } from '../components/ScanControl';
import { RouteDebugOverlay } from '../components/RouteDebugOverlay';
import { SectorStatus } from '../components/SectorStatus';
import { StatusAnnouncement } from '../components/StatusAnnouncement';
import { useLidarScanner } from '../features/scanning/useLidarScanner';
import { useVoiceInput } from '../features/speech/useVoiceInput';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useCallback, useRef, useState } from 'react';
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

  // Walk & talk: hands-free conversation loop. Listen -> user speaks ->
  // companion replies (mic closed while it talks) -> listen again.
  const [walkTalk, setWalkTalk] = useState(false);
  const walkTalkRef = useRef(false);
  const voiceRef = useRef<{ start: () => Promise<void> } | null>(null);

  const resumeListening = useCallback((delayMs: number) => {
    if (!walkTalkRef.current) return;
    setTimeout(() => {
      if (walkTalkRef.current) void voiceRef.current?.start();
    }, delayMs);
  }, []);

  const voice = useVoiceInput(
    (text) => {
      void (async () => {
        await scanner.askCompanion(text); // resolves after the reply is spoken
        resumeListening(350);
      })();
    },
    {
      // Silence or recognition hiccup: quietly reopen the mic.
      onEnd: (gotText) => {
        if (!gotText) resumeListening(600);
      },
    },
  );
  voiceRef.current = voice;

  const toggleWalkTalk = useCallback(() => {
    const next = !walkTalkRef.current;
    walkTalkRef.current = next;
    setWalkTalk(next);
    if (next) void voiceRef.current?.start();
  }, []);
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
    <View style={styles.screen}>
      {scanner.liveDebugFrame ? (
        <Image
          accessibilityIgnoresInvertColors
          blurRadius={2}
          resizeMode="cover"
          source={{ uri: scanner.liveDebugFrame.uri }}
          style={styles.cameraBackground}
        />
      ) : null}
      <View pointerEvents="none" style={styles.backgroundScrim} />
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
              Live navigation
            </Text>
          </View>
          <View style={styles.headerBadge}>
            <View style={[styles.headerBadgeDot, scanner.active && styles.headerBadgeDotActive]} />
            <Text style={styles.headerBadgeText}>{scanner.active ? 'LIVE' : 'READY'}</Text>
          </View>
        </View>

        <ScanControl
          active={scanner.active}
          disabled={unsupported || busy}
          onPress={() => (scanner.active ? void scanner.stop() : void scanner.start())}
          status={scanner.status}
        />

        <RouteDebugOverlay
          active={scanner.active}
          frame={scanner.liveDebugFrame}
          guidance={scanner.guidance}
          route={snapshot?.route}
        />

        {scanner.liveDebugError ? (
          <Text accessibilityRole="alert" style={styles.previewError}>
            Live preview: {scanner.liveDebugError}
          </Text>
        ) : null}

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

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: scanner.alertVoice }}
          accessibilityLabel={
            scanner.alertVoice ? 'Turn off spoken alerts' : 'Turn on spoken alerts'
          }
          accessibilityHint="Spoken obstacle warnings like Stop and Obstacle left. Vibration alerts always stay on."
          onPress={() => scanner.toggleAlertVoice()}
          style={[styles.describe, scanner.alertVoice && styles.companionOn]}
        >
          <Text maxFontSizeMultiplier={1.6} style={styles.describeText}>
            {scanner.alertVoice ? 'Alert voice: on' : 'Alert voice: off'}
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: scanner.companion }}
          accessibilityLabel={
            scanner.companion ? 'Turn off companion mode' : 'Turn on companion mode'
          }
          accessibilityHint="Companion mode talks with you like a friend during your journey."
          onPress={() => scanner.toggleCompanion()}
          style={[styles.describe, scanner.companion && styles.companionOn]}
        >
          <Text maxFontSizeMultiplier={1.6} style={styles.describeText}>
            {scanner.companion ? 'Companion mode: on' : 'Companion mode: off'}
          </Text>
        </Pressable>

        {scanner.companion ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: walkTalk }}
            accessibilityLabel={walkTalk ? 'Stop walk and talk' : 'Start walk and talk'}
            accessibilityHint="Hands-free conversation for the whole journey. The companion listens, answers, then listens again."
            onPress={toggleWalkTalk}
            style={[styles.talk, walkTalk && styles.talkActive]}
          >
            <Text maxFontSizeMultiplier={1.6} style={styles.talkText}>
              {walkTalk
                ? voice.listening
                  ? 'Listening… (tap to stop)'
                  : 'Walk & talk: on (tap to stop)'
                : 'Walk & talk: start conversation'}
            </Text>
          </Pressable>
        ) : null}

        {scanner.companion && !walkTalk ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Hold to talk"
            accessibilityHint="Hold down, speak your question, then release to send it."
            onPressIn={() => void voice.start()}
            onPressOut={() => voice.stop()}
            style={[styles.describe, voice.listening && styles.talkActive]}
          >
            <Text maxFontSizeMultiplier={1.6} style={styles.describeText}>
              {voice.listening ? 'Listening… release to send' : 'Hold to talk (single question)'}
            </Text>
          </Pressable>
        ) : null}

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
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#07090C',
  },
  cameraBackground: {
    ...StyleSheet.absoluteFill,
    opacity: 0.46,
  },
  backgroundScrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(5, 8, 11, 0.64)',
  },
  safeArea: {
    flex: 1,
    backgroundColor: 'transparent',
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
    padding: 12,
    borderRadius: 18,
    backgroundColor: 'rgba(9, 12, 16, 0.76)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
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
  headerBadge: {
    minHeight: 30,
    borderRadius: 15,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  headerBadgeDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#747E8A',
  },
  headerBadgeDotActive: {
    backgroundColor: '#74F2A3',
  },
  headerBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  previewError: {
    color: '#FFAAA6',
    backgroundColor: 'rgba(75, 20, 24, 0.82)',
    borderRadius: 12,
    padding: 12,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
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
    backgroundColor: 'rgba(18, 23, 29, 0.86)',
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
    backgroundColor: 'rgba(8, 11, 14, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  describeDisabled: {
    opacity: 0.4,
  },
  companionOn: {
    backgroundColor: '#2E331A',
    borderColor: '#F2FF63',
    borderWidth: 2,
  },
  talk: {
    minHeight: 72,
    borderRadius: 16,
    backgroundColor: '#F2FF63',
    alignItems: 'center',
    justifyContent: 'center',
  },
  talkActive: {
    backgroundColor: '#FF6B66',
  },
  talkText: {
    color: '#0B0D10',
    fontSize: 18,
    fontWeight: '900',
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
    paddingHorizontal: 4,
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
