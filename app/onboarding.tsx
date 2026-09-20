import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ONBOARDING_STEPS,
  ONBOARDING_STEP_COUNT,
  clampStepIndex,
  isFirstStep,
  isLastStep,
  spokenTextForStep,
} from '../features/onboarding/steps';
import { markOnboardingComplete } from '../features/onboarding/storage';
import { speak, stopSpeaking } from '../features/speech/speech';

export default function OnboardingScreen() {
  const router = useRouter();
  const [stepIndex, setStepIndex] = useState(0);
  const step = ONBOARDING_STEPS[clampStepIndex(stepIndex)];

  // Speak every step through the same voice the scanner uses, so the tour
  // doubles as a preview of how the app will sound while navigating.
  useEffect(() => {
    void stopSpeaking().finally(() => void speak(spokenTextForStep(stepIndex)));
  }, [stepIndex]);

  useEffect(
    () => () => {
      void stopSpeaking();
    },
    [],
  );

  const finish = useCallback(() => {
    markOnboardingComplete();
    void stopSpeaking();
    router.replace('/');
  }, [router]);

  const goNext = useCallback(() => {
    if (isLastStep(stepIndex)) {
      finish();
      return;
    }
    setStepIndex((index) => clampStepIndex(index + 1));
  }, [finish, stepIndex]);

  const goBack = useCallback(() => {
    setStepIndex((index) => clampStepIndex(index - 1));
  }, []);

  const repeat = useCallback(() => {
    void stopSpeaking().finally(() => void speak(spokenTextForStep(stepIndex)));
  }, [stepIndex]);

  return (
    <View style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.topBar}>
          <Text maxFontSizeMultiplier={1.5} style={styles.eyebrow}>
            HOW TO USE PATHFINDER
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Skip guide"
            accessibilityHint="Closes the tutorial and opens the scanner."
            onPress={finish}
            style={({ pressed }) => [styles.skip, pressed && styles.pressed]}
          >
            <Text maxFontSizeMultiplier={1.6} style={styles.skipText}>
              Skip
            </Text>
          </Pressable>
        </View>

        <ScrollView
          alwaysBounceVertical={false}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View
            accessible
            accessibilityRole="header"
            accessibilityLabel={`Step ${clampStepIndex(stepIndex) + 1} of ${ONBOARDING_STEP_COUNT}. ${step.title}.`}
          >
            <Text maxFontSizeMultiplier={1.6} style={styles.progress}>
              STEP {clampStepIndex(stepIndex) + 1} OF {ONBOARDING_STEP_COUNT}
            </Text>
            <Text maxFontSizeMultiplier={1.8} style={styles.title}>
              {step.title}
            </Text>
          </View>

          <Text
            accessible
            maxFontSizeMultiplier={2.2}
            style={styles.body}
          >
            {step.body}
          </Text>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Repeat this step aloud"
            onPress={repeat}
            style={({ pressed }) => [styles.repeat, pressed && styles.pressed]}
          >
            <Text maxFontSizeMultiplier={1.8} style={styles.repeatText}>
              Repeat aloud
            </Text>
          </Pressable>
        </ScrollView>

        <View style={styles.dots} accessibilityElementsHidden>
          {ONBOARDING_STEPS.map((item, index) => (
            <View
              key={item.key}
              style={[
                styles.dot,
                index === clampStepIndex(stepIndex) && styles.dotActive,
              ]}
            />
          ))}
        </View>

        <View style={styles.controls}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous step"
            accessibilityState={{ disabled: isFirstStep(stepIndex) }}
            disabled={isFirstStep(stepIndex)}
            onPress={goBack}
            style={({ pressed }) => [
              styles.secondaryButton,
              isFirstStep(stepIndex) && styles.disabled,
              pressed && !isFirstStep(stepIndex) && styles.pressed,
            ]}
          >
            <Text maxFontSizeMultiplier={1.6} style={styles.secondaryLabel}>
              Back
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              isLastStep(stepIndex) ? 'Finish guide and open scanner' : 'Next step'
            }
            onPress={goNext}
            style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
          >
            <Text maxFontSizeMultiplier={1.6} style={styles.primaryLabel}>
              {isLastStep(stepIndex) ? 'Finish' : 'Next'}
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#07090C',
  },
  safeArea: {
    flex: 1,
    paddingHorizontal: 20,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 14,
    paddingBottom: 6,
  },
  eyebrow: {
    color: '#F2FF63',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '900',
    letterSpacing: 2.1,
  },
  skip: {
    minHeight: 44,
    minWidth: 66,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    paddingHorizontal: 14,
  },
  skipText: {
    color: '#DCE1E8',
    fontSize: 15,
    fontWeight: '800',
  },
  content: {
    paddingTop: 26,
    paddingBottom: 24,
    gap: 18,
    flexGrow: 1,
  },
  progress: {
    color: '#8E97A3',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '800',
    letterSpacing: 1.4,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 34,
    lineHeight: 41,
    fontWeight: '800',
    letterSpacing: -0.6,
    marginTop: 8,
  },
  body: {
    color: '#C7CDD5',
    fontSize: 19,
    lineHeight: 30,
    fontWeight: '500',
  },
  repeat: {
    minHeight: 56,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#3A414C',
    backgroundColor: 'rgba(18, 23, 29, 0.86)',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 22,
  },
  repeatText: {
    color: '#DCE1E8',
    fontSize: 16,
    fontWeight: '800',
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#3A414C',
  },
  dotActive: {
    backgroundColor: '#F2FF63',
    width: 22,
  },
  controls: {
    flexDirection: 'row',
    gap: 12,
    paddingBottom: 18,
  },
  secondaryButton: {
    flex: 1,
    minHeight: 64,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: '#3A414C',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(18, 23, 29, 0.86)',
  },
  secondaryLabel: {
    color: '#DCE1E8',
    fontSize: 19,
    fontWeight: '800',
  },
  primaryButton: {
    flex: 2,
    minHeight: 64,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F2FF63',
    borderWidth: 2,
    borderColor: '#F2FF63',
  },
  primaryLabel: {
    color: '#0B0D10',
    fontSize: 19,
    fontWeight: '800',
  },
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    transform: [{ scale: 0.985 }],
  },
});
