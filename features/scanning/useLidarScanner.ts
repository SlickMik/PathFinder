import { DEFAULT_LIDAR_OPTIONS } from '../../config/thresholds';
import { ExpoLidarVision } from '../../modules/expo-lidar-vision';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { INITIAL_ALERT_STATE, reduceAlertState } from './alertPolicy';
import {
  INITIAL_GROUND_HAZARD_STATE,
  escalateRisk,
  groundHazardRisk,
  reduceGroundHazardState,
} from './groundHazards';
import { companionSay, resetCompanion, understandAudio } from '../speech/companion';
import { readAsStringAsync } from 'expo-file-system/legacy';
import { describeCurrentScene, fetchSceneHazards } from '../speech/sceneDescriber';
import type { SceneHazard } from '../speech/sceneDescriber';
import { speak, speakStream, stopSpeaking } from '../speech/speech';
import { emitRiskHaptic, hapticIntervalMs } from './haptics';
import { safetyEnvelopeForSpeed } from './motionSafety';
import {
  INITIAL_NAVIGATION_GUIDANCE,
  planNavigation,
  reduceNavigationGuidance,
  surfacePhrase,
} from './navigation';
import {
  localSceneFallback,
  localSensorReply,
  needsVisualContext,
} from './localCompanion';
import { CLOUD_AI_ENABLED } from '../speech/featureFlags';
import type {
  AlertState,
  GroundHazardAlertState,
  LidarSupport,
  LiveDebugFrame,
  NavigationGuidance,
  ObstacleSnapshot,
  ScannerStatus,
} from './types';

const KEEP_AWAKE_TAG = 'pathfinder-lidar-session';
const INITIAL_SAFETY_ENVELOPE = safetyEnvelopeForSpeed(
  0,
  DEFAULT_LIDAR_OPTIONS.reactionTimeS,
);

export function useLidarScanner() {
  const [support, setSupport] = useState<LidarSupport | null>(null);
  const [status, setStatus] = useState<ScannerStatus>('checking');
  const [active, setActive] = useState(false);
  const [snapshot, setSnapshot] = useState<ObstacleSnapshot | null>(null);
  const [alert, setAlert] = useState<AlertState>(INITIAL_ALERT_STATE);
  const [groundHazard, setGroundHazard] = useState<GroundHazardAlertState>(
    INITIAL_GROUND_HAZARD_STATE,
  );
  const [guidance, setGuidance] = useState<NavigationGuidance>(
    INITIAL_NAVIGATION_GUIDANCE,
  );
  const [safetyEnvelope, setSafetyEnvelope] = useState(INITIAL_SAFETY_ENVELOPE);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [liveDebugFrame, setLiveDebugFrame] = useState<LiveDebugFrame | null>(null);
  const [liveDebugError, setLiveDebugError] = useState<string | null>(null);
  const alertRef = useRef(INITIAL_ALERT_STATE);
  const groundHazardRef = useRef(INITIAL_GROUND_HAZARD_STATE);
  const guidanceRef = useRef(INITIAL_NAVIGATION_GUIDANCE);
  const snapshotRef = useRef<ObstacleSnapshot | null>(null);
  // Navigation starts quiet except for concise, deterministic guidance. The
  // conversational companion remains opt-in so it never masks safety speech.
  const companionRef = useRef(false);
  const [companion, setCompanionState] = useState(false);
  // Spoken obstacle and route guidance is a primary accessibility channel.
  // Haptics remain active regardless of this preference.
  const alertVoiceRef = useRef(true);
  const [alertVoice, setAlertVoiceState] = useState(true);
  const lastAnnouncementRef = useRef({ text: '', timestamp: 0 });
  const lastGuidanceSpeechRef = useRef({
    instruction: 'hold',
    surfaceClass: null as NavigationGuidance['surfaceClass'],
    timestamp: 0,
  });
  const lastAlertSpeechRef = useRef({ text: '', timestamp: 0 });
  // Rolling log of journey moments (guidance/risk changes) so the companion
  // can reference what just happened on the walk.
  const journeyEventsRef = useRef<Array<{ at: number; event: string }>>([]);
  const [sceneHazards, setSceneHazards] = useState<SceneHazard[]>([]);
  // Journey stats for the end-of-walk debrief.
  const journeyStatsRef = useRef({
    startedAt: null as number | null,
    nearCount: 0,
    criticalCount: 0,
    guidanceChanges: 0,
  });

  const logJourneyEvent = useCallback((event: string) => {
    const events = journeyEventsRef.current;
    events.push({ at: Date.now(), event });
    if (events.length > 8) events.shift();
  }, []);

  useEffect(() => {
    let cancelled = false;

    ExpoLidarVision.isSupported()
      .then((result) => {
        if (cancelled) return;
        setSupport(result);
        setStatus(result.supported ? 'ready' : 'unsupported');
      })
      .catch(() => {
        if (cancelled) return;
        setSupport({ supported: false, reason: 'no-lidar' });
        setStatus('unsupported');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const announce = useCallback((text: string, critical = false) => {
    const now = Date.now();
    const last = lastAnnouncementRef.current;
    if (!critical && last.text === text && now - last.timestamp < 5000) return;
    lastAnnouncementRef.current = { text, timestamp: now };
    void speak(text, critical);
  }, []);

  const speakGuidance = useCallback(
    (nextGuidance: NavigationGuidance, previousGuidance: NavigationGuidance) => {
      if (!alertVoiceRef.current) return;
      if (!nextGuidance.phrase || nextGuidance.instruction === 'hold') return;

      const now = Date.now();
      const last = lastGuidanceSpeechRef.current;
      const directionChanged = nextGuidance.instruction !== previousGuidance.instruction;
      const surfaceChanged =
        nextGuidance.surfaceClass !== null &&
        nextGuidance.surfaceClass !== last.surfaceClass;
      const changed = directionChanged || surfaceChanged;
      const repeatAfterMs = nextGuidance.instruction === 'stop' ? 1600 : 5000;
      if (!changed && now - last.timestamp < repeatAfterMs) return;
      if (last.instruction === nextGuidance.instruction &&
          now - last.timestamp < (surfaceChanged ? 3000 : repeatAfterMs)) {
        return;
      }

      lastGuidanceSpeechRef.current = {
        instruction: nextGuidance.instruction,
        surfaceClass: nextGuidance.surfaceClass,
        timestamp: now,
      };
      const detectedSurface = surfaceChanged && nextGuidance.instruction !== 'stop'
        ? surfacePhrase(nextGuidance.surfaceClass)
        : null;
      const phrase = detectedSurface
        ? `${nextGuidance.phrase} ${detectedSurface}`
        : nextGuidance.phrase;
      void stopSpeaking().finally(() =>
        speak(phrase, nextGuidance.instruction === 'stop'),
      );
    },
    [],
  );

  useEffect(() => {
    const snapshotSubscription = ExpoLidarVision.onSnapshot((nextSnapshot) => {
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);

      const nextSafetyEnvelope = safetyEnvelopeForSpeed(
        nextSnapshot.motion.speedMps,
        DEFAULT_LIDAR_OPTIONS.reactionTimeS,
      );
      setSafetyEnvelope(nextSafetyEnvelope);

      const nextAlert = reduceAlertState(
        alertRef.current,
        nextSnapshot,
        nextSafetyEnvelope,
      );
      if (nextAlert.risk !== alertRef.current.risk) {
        logJourneyEvent(`obstacle risk went from ${alertRef.current.risk} to ${nextAlert.risk}`);
        if (nextAlert.risk === 'near') journeyStatsRef.current.nearCount += 1;
        if (nextAlert.risk === 'critical') journeyStatsRef.current.criticalCount += 1;
      }
      alertRef.current = nextAlert;
      setAlert(nextAlert);

      const nextGroundHazard = reduceGroundHazardState(
        groundHazardRef.current,
        nextSnapshot,
      );
      groundHazardRef.current = nextGroundHazard;
      setGroundHazard(nextGroundHazard);

      const previousGuidance = guidanceRef.current;
      const nextGuidance = reduceNavigationGuidance(
        previousGuidance,
        planNavigation(nextSnapshot, nextSafetyEnvelope),
      );
      guidanceRef.current = nextGuidance;
      setGuidance(nextGuidance);
      speakGuidance(nextGuidance, previousGuidance);

      if (
        nextGuidance.instruction !== previousGuidance.instruction &&
        nextGuidance.instruction !== 'hold'
      ) {
        logJourneyEvent(`guidance changed to "${nextGuidance.instruction}" (${nextGuidance.source})`);
        journeyStatsRef.current.guidanceChanges += 1;
      }

      const viewValid =
        nextSnapshot.tracking === 'normal' && nextSnapshot.deviceAim === 'forward';
      setStatus(viewValid ? 'scanning' : 'paused');
      if (viewValid) setErrorMessage(null);

      if (nextAlert.announcement && alertVoiceRef.current) {
        // Alert speech pacing. Without this, sector flapping (left/center)
        // re-announces at up to 10 Hz and critical alerts interrupt
        // themselves constantly.
        const critical = nextAlert.risk === 'critical';
        const now = Date.now();
        const last = lastAlertSpeechRef.current;
        const repeatSameText = last.text === nextAlert.announcement && now - last.timestamp < 2500;
        const tooSoonForNonCritical = !critical && now - last.timestamp < 3000;
        if (!repeatSameText && !tooSoonForNonCritical) {
          lastAlertSpeechRef.current = { text: nextAlert.announcement, timestamp: now };
          announce(nextAlert.announcement, critical);
        }
      }

      if (nextGroundHazard.announcement && alertVoiceRef.current) {
        announce(
          nextGroundHazard.announcement,
          groundHazardRisk(nextGroundHazard) === 'critical',
        );
      }
    });

    const errorSubscription = ExpoLidarVision.onError((error) => {
      alertRef.current = INITIAL_ALERT_STATE;
      setAlert(INITIAL_ALERT_STATE);
      groundHazardRef.current = INITIAL_GROUND_HAZARD_STATE;
      setGroundHazard(INITIAL_GROUND_HAZARD_STATE);
      guidanceRef.current = INITIAL_NAVIGATION_GUIDANCE;
      setGuidance(INITIAL_NAVIGATION_GUIDANCE);
      setSafetyEnvelope(INITIAL_SAFETY_ENVELOPE);
      setErrorMessage(error.message);
      setStatus(error.recoverable ? 'paused' : 'error');
      if (!error.recoverable) {
        setActive(false);
        setSnapshot(null);
        deactivateKeepAwake(KEEP_AWAKE_TAG);
      }
      announce(error.message);
    });

    return () => {
      snapshotSubscription.remove();
      errorSubscription.remove();
    };
  }, [announce, speakGuidance]);

  const stop = useCallback(async (announceStop = true) => {
    await ExpoLidarVision.stop();
    setActive(false);
    snapshotRef.current = null;
    setSnapshot(null);
    alertRef.current = INITIAL_ALERT_STATE;
    setAlert(INITIAL_ALERT_STATE);
    groundHazardRef.current = INITIAL_GROUND_HAZARD_STATE;
    setGroundHazard(INITIAL_GROUND_HAZARD_STATE);
    guidanceRef.current = INITIAL_NAVIGATION_GUIDANCE;
    setGuidance(INITIAL_NAVIGATION_GUIDANCE);
    setSafetyEnvelope(INITIAL_SAFETY_ENVELOPE);
    lastGuidanceSpeechRef.current = {
      instruction: 'hold',
      surfaceClass: null,
      timestamp: 0,
    };
    setLiveDebugFrame(null);
    setLiveDebugError(null);
    setStatus((current) => (current === 'unsupported' ? current : 'ready'));
    deactivateKeepAwake(KEEP_AWAKE_TAG);
    void stopSpeaking();
    if (announceStop) {
      void speak('Obstacle alerts stopped.');
      if (companionRef.current) {
        // Journey debrief — async, no latency budget. Kimi gets the walk's
        // stats and recent events and closes out the journey warmly.
        const stats = journeyStatsRef.current;
        const durationS = stats.startedAt
          ? Math.round((Date.now() - stats.startedAt) / 1000)
          : 0;
        const now = Date.now();
        const recentEvents = journeyEventsRef.current.map(
          (entry) => `${Math.round((now - entry.at) / 1000)}s ago: ${entry.event}`,
        );
        const debriefPrompt =
          `The walk just ended. Give me a short, warm end-of-journey debrief (2-3 sentences). ` +
          `Stats: duration ${Math.floor(durationS / 60)}m ${durationS % 60}s, ` +
          `close-call moments: ${stats.nearCount}, critical stops: ${stats.criticalCount}, ` +
          `direction changes: ${stats.guidanceChanges}.`;
        const speech = speakStream();
        void companionSay(debriefPrompt, {
          events: recentEvents,
          onDelta: (delta) => speech.push(delta),
        })
          .then(() => speech.done())
          .catch(() => {});
      }
    }
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active' && active) void stop(false);
    });
    return () => subscription.remove();
  }, [active, stop]);

  const hazardRiskLevel = groundHazardRisk(groundHazard);
  useEffect(() => {
    if (!active) return;
    const effectiveRisk = escalateRisk(alert.risk, hazardRiskLevel);
    const intervalMs = hapticIntervalMs(effectiveRisk);
    if (intervalMs === null) return;

    void emitRiskHaptic(effectiveRisk);
    const timer = setInterval(
      () =>
        void emitRiskHaptic(
          escalateRisk(
            alertRef.current.risk,
            groundHazardRisk(groundHazardRef.current),
          ),
        ),
      intervalMs,
    );
    return () => clearInterval(timer);
  }, [active, alert.risk, hazardRiskLevel]);

  useEffect(() => {
    if (!active) {
      setLiveDebugFrame(null);
      setLiveDebugError(null);
      return;
    }

    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const refresh = async () => {
      try {
        const frame = await ExpoLidarVision.captureDebugFrame(640, 0.45);
        if (cancelled) return;
        const { base64, ...metadata } = frame;
        setLiveDebugFrame({
          ...metadata,
          uri: `data:image/jpeg;base64,${base64}`,
          capturedAtMs: Date.now(),
        });
        setLiveDebugError(null);
      } catch (error) {
        if (cancelled) return;
        setLiveDebugError(
          error instanceof Error ? error.message : 'Live camera preview is unavailable.',
        );
      } finally {
        if (!cancelled) refreshTimer = setTimeout(() => void refresh(), 350);
      }
    };

    void refresh();
    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [active]);

  useEffect(
    () => () => {
      void ExpoLidarVision.stop();
      void stopSpeaking();
      deactivateKeepAwake(KEEP_AWAKE_TAG);
    },
    [],
  );

  const start = useCallback(async () => {
    if (!support?.supported) return;
    setStatus('starting');
    setErrorMessage(null);

    try {
      const granted = await ExpoLidarVision.requestPermission();
      if (!granted) {
        setStatus('permission-denied');
        announce('Camera permission denied. Obstacle alerts cannot start.');
        return;
      }

      await ExpoLidarVision.start(DEFAULT_LIDAR_OPTIONS);
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
      journeyStatsRef.current = {
        startedAt: Date.now(),
        nearCount: 0,
        criticalCount: 0,
        guidanceChanges: 0,
      };
      journeyEventsRef.current = [];
      setSceneHazards([]);
      setActive(true);
      setStatus('scanning');
      if (companionRef.current) {
        // Deterministic confirmation first, then the streamed greeting.
        announce('Obstacle alerts started.');
        const greeting = speakStream();
        void companionSay(
          "I've just turned on obstacle alerts and I'm heading out — walk with me.",
          { snapshot: snapshotRef.current, onDelta: (delta) => greeting.push(delta) },
        )
          .then(() => greeting.done())
          .catch(() => {});
      } else {
        announce('Obstacle alerts started. Hold the phone upright and point it forward.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start LiDAR.';
      setErrorMessage(message);
      setStatus('error');
      setActive(false);
      announce(message);
    }
  }, [announce, support]);

  const describeScene = useCallback(async () => {
    if (!active) return;
    if (!CLOUD_AI_ENABLED) {
      announce(localSceneFallback(snapshotRef.current, alertRef.current, guidanceRef.current));
      return;
    }
    let receivedCloudSpeech = false;
    try {
      announce('Describing scene.');
      // Structured Gemini hazards run in parallel and land in
      // the UI whenever ready, never delays the spoken description.
      void fetchSceneHazards(snapshotRef.current)
        .then(setSceneHazards)
        .catch(() => {});
      // Stream the description so the first sentence is spoken as soon as the
      // model produces it, instead of after the whole reply returns. Guard
      // against critical alerts: this is the longest reply (max 160 tokens) and
      // runs mid-walk, so it is the most likely to be cut off by a STOP alert —
      // without the guard, still-arriving sentences would talk over the STOP.
      const speech = speakStream(
        () =>
          alertRef.current.risk !== 'critical' &&
          groundHazardRisk(groundHazardRef.current) !== 'critical',
      );
      const text = companionRef.current
        ? await companionSay('What do you see around us right now?', {
            snapshot: snapshotRef.current,
            withFrame: true,
            onDelta: (delta) => {
              receivedCloudSpeech = true;
              speech.push(delta);
            },
          })
        : await describeCurrentScene(snapshotRef.current, (delta) => {
            receivedCloudSpeech = true;
            speech.push(delta);
          });
      await speech.done();
      console.log(`[describe-scene] reply: "${text}"`);
    } catch (error) {
      console.warn('[describe-scene] cloud description failed:', error);
      if (!receivedCloudSpeech) {
        announce(
          localSceneFallback(snapshotRef.current, alertRef.current, guidanceRef.current),
        );
      }
    }
  }, [active, announce]);
  const tryUnderstandAudio = useCallback(
    async (audioUri: string, recentEvents: string[], withFrame: boolean) => {
      try {
        const audioBase64 = await readAsStringAsync(audioUri, { encoding: 'base64' });
        const extension = audioUri.split('.').pop()?.toLowerCase() ?? 'caf';
        const audioMime =
          extension === 'wav' ? 'audio/wav' : extension === 'caf' ? 'audio/x-caf' : 'audio/m4a';
        return await understandAudio(audioBase64, audioMime, {
          snapshot: snapshotRef.current,
          alert: alertRef.current,
          guidance: guidanceRef.current,
          events: recentEvents,
          withFrame,
        });
      } catch (error) {
        console.warn('[companion] audio read failed, using local transcript:', error);
        return null;
      }
    },
    [],
  );

  const askCompanion = useCallback(
    async (text: string, audioUri: string | null = null) => {
      console.log(`[companion] user said: "${text}"`);
      try {
        // The user spoke — cut off any ongoing narration immediately.
        await stopSpeaking();
        const now = Date.now();
        const recentEvents = journeyEventsRef.current
          .filter((entry) => now - entry.at < 90_000)
          .map((entry) => `${Math.round((now - entry.at) / 1000)}s ago: ${entry.event}`);

        const localReply = localSensorReply(
          text,
          snapshotRef.current,
          alertRef.current,
          guidanceRef.current,
        );
        if (localReply) {
          console.log(`[companion] answered on device: "${localReply}"`);
          await speak(
            localReply,
            alertRef.current.risk === 'critical' ||
              groundHazardRisk(groundHazardRef.current) === 'critical' ||
              guidanceRef.current.instruction === 'stop',
          );
          return;
        }

        if (!CLOUD_AI_ENABLED) {
          await speak(
            localSceneFallback(snapshotRef.current, alertRef.current, guidanceRef.current),
            alertRef.current.risk === 'critical' ||
              groundHazardRisk(groundHazardRef.current) === 'critical' ||
              guidanceRef.current.instruction === 'stop',
          );
          return;
        }

        const withFrame = active && needsVisualContext(text);

        // Gemini ears: when raw audio was persisted and Gemini is configured,
        // send the audio itself so the model hears the original
        // speech (noise, accents, mumbles) instead of trusting on-device STT.
        if (audioUri) {
          const understood = await tryUnderstandAudio(audioUri, recentEvents, withFrame);
          if (understood) {
            console.log(`[companion] Gemini heard: "${understood.transcript}"`);
            console.log(`[companion] reply: "${understood.reply}"`);
            const speech = speakStream(
              () =>
                alertRef.current.risk !== 'critical' &&
                groundHazardRisk(groundHazardRef.current) !== 'critical',
            );
            speech.push(understood.reply);
            await speech.done();
            return;
          }
        }
        // Stream the reply into incremental TTS: the first sentence starts
        // speaking ~1s after the user stops talking, while the model is still
        // generating the rest. The guard yields to a critical local obstacle
        // alert — if one fires mid-reply, further sentences are dropped so the
        // companion does not resume talking over a STOP alert.
        const speech = speakStream(
          () =>
            alertRef.current.risk !== 'critical' &&
            groundHazardRisk(groundHazardRef.current) !== 'critical',
        );
        const reply = await companionSay(text, {
          snapshot: snapshotRef.current,
          alert: alertRef.current,
          guidance: guidanceRef.current,
          events: recentEvents,
          // Only visual questions get a frame. Sensor questions were already
          // answered locally above, and casual conversation needs no upload.
          withFrame,
          onDelta: (delta) => speech.push(delta),
        });
        await speech.done();
        console.log(`[companion] reply: "${reply}"`);
      } catch (error) {
        console.warn('[companion] request failed:', error);
        announce('Companion is unavailable right now.');
      }
    },
    [active, announce, tryUnderstandAudio],
  );

  const toggleAlertVoice = useCallback(() => {
    const next = !alertVoiceRef.current;
    alertVoiceRef.current = next;
    setAlertVoiceState(next);
    void speak(next ? 'Alert voice on.' : 'Alert voice off. Haptics stay on.', true);
  }, []);

  const toggleCompanion = useCallback(() => {
    if (!CLOUD_AI_ENABLED) {
      void speak('Cloud companion is off. Local guidance is still active.', true);
      return;
    }
    const next = !companionRef.current;
    companionRef.current = next;
    setCompanionState(next);
    if (next) {
      resetCompanion();
      announce('Companion mode on.');
      const greeting = speakStream();
      void companionSay("Hey, I'm here — keeping you company on the way today.", {
        snapshot: snapshotRef.current,
        onDelta: (delta) => greeting.push(delta),
      })
        .then(() => greeting.done())
        .catch(() => {});
    } else {
      announce('Companion mode off.');
    }
  }, [announce]);

  return {
    active,
    alertVoice,
    sceneHazards,
    toggleAlertVoice,
    askCompanion,
    companion,
    toggleCompanion,
    describeScene,
    alert,
    errorMessage,
    groundHazard,
    guidance,
    liveDebugError,
    liveDebugFrame,
    safetyEnvelope,
    snapshot,
    start,
    status,
    stop,
    support,
  };
}
