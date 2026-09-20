import type { NavigationGuidance } from '../features/scanning/types';
import { AccessibilityInfo, Animated, StyleSheet, Text, View } from 'react-native';
import { useEffect, useMemo, useState } from 'react';

type Props = {
  active: boolean;
  guidance: NavigationGuidance;
  speedMps: number;
  warningDistanceM: number;
};

const GUIDANCE_LABEL = {
  hold: 'Hold position',
  stop: 'Stop',
  straight: 'Go straight',
  'slight-left': 'Go slightly left',
  left: 'Go left',
  'slight-right': 'Go slightly right',
  right: 'Go right',
} as const;

const GUIDANCE_DETAIL = {
  hold: 'Waiting for a reliable path',
  stop: 'Do not move forward',
  straight: 'Stay centered on the path',
  'slight-left': 'Ease toward the left',
  left: 'Turn toward the left',
  'slight-right': 'Ease toward the right',
  right: 'Turn toward the right',
} as const;

const ANGLE = {
  hold: 0,
  stop: 0,
  straight: 0,
  'slight-left': -17,
  left: -36,
  'slight-right': 17,
  right: 36,
} as const;

export function GuidanceInstrument({ active, guidance, speedMps, warningDistanceM }: Props) {
  const direction = active ? guidance.instruction : 'hold';
  const [motion] = useState(() => new Animated.Value(0));
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const value = ANGLE[direction];
    if (reduceMotion) {
      motion.setValue(value);
      return;
    }
    Animated.spring(motion, {
      toValue: value,
      damping: 15,
      stiffness: 135,
      mass: 0.8,
      useNativeDriver: true,
    }).start();
  }, [direction, motion, reduceMotion]);

  const animatedStyle = useMemo(
    () => ({
      transform: [
        {
          translateX: motion.interpolate({
            inputRange: [-36, 0, 36],
            outputRange: [-52, 0, 52],
          }),
        },
        {
          rotate: motion.interpolate({
            inputRange: [-36, 36],
            outputRange: ['-36deg', '36deg'],
          }),
        },
      ],
    }),
    [motion],
  );

  const title = active ? GUIDANCE_LABEL[direction] : 'Ready to guide';
  const detail = active ? GUIDANCE_DETAIL[direction] : 'Start navigation when you are ready';
  const isStop = active && direction === 'stop';

  return (
    <View
      accessible
      accessibilityLabel={`${title}. ${detail}. Speed ${speedMps.toFixed(1)} metres per second. Alert range ${warningDistanceM.toFixed(1)} metres.`}
      accessibilityLiveRegion="polite"
      accessibilityRole="summary"
      style={[styles.card, isStop && styles.cardStop]}
    >
      <View style={styles.copy}>
        <View style={styles.eyebrowRow}>
          <View style={[styles.signal, active && !isStop && styles.signalActive, isStop && styles.signalStop]} />
          <Text maxFontSizeMultiplier={1.8} style={styles.eyebrow}>
            NEXT MOVE
          </Text>
        </View>
        <Text maxFontSizeMultiplier={1.5} numberOfLines={2} style={styles.title}>
          {title}
        </Text>
        <Text maxFontSizeMultiplier={1.8} style={styles.detail}>
          {detail}
        </Text>
        <View style={styles.metrics}>
          <Metric label="SPEED" value={`${speedMps.toFixed(1)} m/s`} />
          <View style={styles.metricDivider} />
          <Metric label="ALERT RANGE" value={`${warningDistanceM.toFixed(1)} m`} />
        </View>
        {active && guidance.isNarrowOpening ? (
          <View style={styles.narrowBadge}>
            <Text maxFontSizeMultiplier={1.5} style={styles.narrowText}>
              NARROW OPENING · KEEP CENTERED
            </Text>
          </View>
        ) : null}
      </View>

      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.stage}>
        <View style={styles.centerGlow} />
        <View style={styles.pathLeft} />
        <View style={styles.pathCenter} />
        <View style={styles.pathRight} />
        {isStop ? (
          <View style={styles.stopSign}>
            <View style={styles.stopBar} />
          </View>
        ) : (
          <Animated.View style={[styles.arrow, animatedStyle]}>
            <View style={styles.arrowHead} />
            <View style={styles.arrowStem} />
          </Animated.View>
        )}
        <View style={styles.youMarker} />
      </View>
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text maxFontSizeMultiplier={1.5} style={styles.metricLabel}>
        {label}
      </Text>
      <Text maxFontSizeMultiplier={1.6} style={styles.metricValue}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: 310,
    borderRadius: 28,
    overflow: 'hidden',
    flexDirection: 'row',
    backgroundColor: '#F4FF72',
    borderWidth: 2,
    borderColor: '#F4FF72',
    shadowColor: '#D9EF34',
    shadowOpacity: 0.22,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 9 },
  },
  cardStop: {
    backgroundColor: '#FF625B',
    borderColor: '#FF918C',
    shadowColor: '#FF625B',
  },
  copy: {
    flex: 1.15,
    paddingHorizontal: 22,
    paddingVertical: 24,
    zIndex: 2,
  },
  eyebrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  signal: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: '#626834',
  },
  signalActive: {
    backgroundColor: '#0B0E11',
  },
  signalStop: {
    backgroundColor: '#FFFFFF',
  },
  eyebrow: {
    color: '#3E430A',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '900',
    letterSpacing: 1.8,
  },
  title: {
    color: '#090C0F',
    fontSize: 38,
    lineHeight: 42,
    fontWeight: '900',
    letterSpacing: -1.2,
    marginTop: 13,
  },
  detail: {
    color: '#34380A',
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '700',
    marginTop: 6,
  },
  metrics: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginTop: 23,
    gap: 15,
  },
  metric: {
    gap: 2,
  },
  metricDivider: {
    width: 1,
    backgroundColor: 'rgba(9, 12, 15, 0.24)',
  },
  metricLabel: {
    color: '#555B19',
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '900',
    letterSpacing: 1,
  },
  metricValue: {
    color: '#090C0F',
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  narrowBadge: {
    alignSelf: 'flex-start',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: 'rgba(9, 12, 15, 0.12)',
    marginTop: 14,
  },
  narrowText: {
    color: '#090C0F',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  stage: {
    width: '40%',
    minWidth: 132,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  centerGlow: {
    position: 'absolute',
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: 'rgba(255, 255, 255, 0.26)',
  },
  pathLeft: {
    position: 'absolute',
    top: 0,
    bottom: -45,
    left: 25,
    width: 2,
    backgroundColor: 'rgba(9, 12, 15, 0.13)',
    transform: [{ rotate: '9deg' }],
  },
  pathCenter: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: '50%',
    width: 2,
    backgroundColor: 'rgba(9, 12, 15, 0.13)',
  },
  pathRight: {
    position: 'absolute',
    top: 0,
    bottom: -45,
    right: 25,
    width: 2,
    backgroundColor: 'rgba(9, 12, 15, 0.13)',
    transform: [{ rotate: '-9deg' }],
  },
  arrow: {
    width: 88,
    height: 142,
    alignItems: 'center',
    justifyContent: 'flex-start',
    marginTop: -8,
  },
  arrowHead: {
    width: 0,
    height: 0,
    borderLeftWidth: 39,
    borderRightWidth: 39,
    borderBottomWidth: 58,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#0A0D10',
  },
  arrowStem: {
    width: 28,
    height: 82,
    marginTop: -1,
    borderBottomLeftRadius: 14,
    borderBottomRightRadius: 14,
    backgroundColor: '#0A0D10',
  },
  stopSign: {
    width: 106,
    height: 106,
    borderRadius: 53,
    backgroundColor: '#0A0D10',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopBar: {
    width: 58,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#FFFFFF',
  },
  youMarker: {
    position: 'absolute',
    bottom: 18,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#0A0D10',
    borderWidth: 4,
    borderColor: 'rgba(255, 255, 255, 0.72)',
  },
});
