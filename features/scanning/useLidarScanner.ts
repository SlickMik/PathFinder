import { DEFAULT_LIDAR_OPTIONS } from '../../config/thresholds';
import { ExpoLidarVision } from '../../modules/expo-lidar-vision';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { INITIAL_ALERT_STATE, reduceAlertState } from './alertPolicy';
import { companionSay, resetCompanion } from '../speech/companion';
import { describeCurrentScene } from '../speech/sceneDescriber';
import { speak, speakStream, stopSpeaking } from '../speech/speech';
import { emitRiskHaptic, hapticIntervalMs } from './haptics';
import { safetyEnvelopeForSpeed } from './motionSafety';
import {
  INITIAL_NAVIGATION_GUIDANCE,
  planNavigation,
  reduceNavigationGuidance,
} from './navigation';
import type {
  AlertState,
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
  const [guidance, setGuidance] = useState<NavigationGuidance>(
    INITIAL_NAVIGATION_GUIDANCE,
  );
  const [safetyEnvelope, setSafetyEnvelope] = useState(INITIAL_SAFETY_ENVELOPE);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [liveDebugFrame, setLiveDebugFrame] = useState<LiveDebugFrame | null>(null);
  const [liveDebugError, setLiveDebugError] = useState<string | null>(null);
  const alertRef = useRef(INITIAL_ALERT_STATE);
  const guidanceRef = useRef(INITIAL_NAVIGATION_GUIDANCE);
  const snapshotRef = useRef<ObstacleSnapshot | null>(null);
  // Sponsor experience (Baseten-powered companion) is on by default;
  // deterministic local alerts still take priority over all of it.
  const companionRef = useRef(true);
  const [companion, setCompanionState] = useState(true);
  // Spoken obstacle/guidance alerts ("Stop", "Obstacle left"). OFF by default
  // so they don't talk over the companion — haptics always stay on regardless.
  const alertVoiceRef = useRef(false);
  const [alertVoice, setAlertVoiceState] = useState(false);
  const lastAnnouncementRef = useRef({ text: '', timestamp: 0 });
  const lastGuidanceSpeechRef = useRef({ instruction: 'hold', timestamp: 0 });
  const lastAlertSpeechRef = useRef({ text: '', timestamp: 0 });
  // Rolling log of journey moments (guidance/risk changes) so the companion
  // can reference what just happened on the walk.
  const journeyEventsRef = useRef<Array<{ at: number; event: string }>>([]);

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
      const changed = nextGuidance.instruction !== previousGuidance.instruction;
      const repeatAfterMs = nextGuidance.instruction === 'stop' ? 1600 : 5000;
      if (!changed && now - last.timestamp < repeatAfterMs) return;
      if (last.instruction === nextGuidance.instruction && now - last.timestamp < repeatAfterMs) {
        return;
      }

      lastGuidanceSpeechRef.current = {
        instruction: nextGuidance.instruction,
        timestamp: now,
      };
      void stopSpeaking().finally(() =>
        speak(nextGuidance.phrase!, nextGuidance.instruction === 'stop'),
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
      }
      alertRef.current = nextAlert;
      setAlert(nextAlert);

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
    });

    const errorSubscription = ExpoLidarVision.onError((error) => {
      alertRef.current = INITIAL_ALERT_STATE;
      setAlert(INITIAL_ALERT_STATE);
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
    guidanceRef.current = INITIAL_NAVIGATION_GUIDANCE;
    setGuidance(INITIAL_NAVIGATION_GUIDANCE);
    setSafetyEnvelope(INITIAL_SAFETY_ENVELOPE);
    lastGuidanceSpeechRef.current = { instruction: 'hold', timestamp: 0 };
    setLiveDebugFrame(null);
    setLiveDebugError(null);
    setStatus((current) => (current === 'unsupported' ? current : 'ready'));
    deactivateKeepAwake(KEEP_AWAKE_TAG);
    void stopSpeaking();
    if (announceStop) {
      void speak('Obstacle alerts stopped.');
      if (companionRef.current) {
        const speech = speakStream();
        void companionSay("I've stopped for now — that's the end of this stretch of the journey.", {
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

  useEffect(() => {
    if (!active) return;
    const intervalMs = hapticIntervalMs(alert.risk);
    if (intervalMs === null) return;

    void emitRiskHaptic(alert.risk);
    const timer = setInterval(() => void emitRiskHaptic(alertRef.current.risk), intervalMs);
    return () => clearInterval(timer);
  }, [active, alert.risk]);

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
    try {
      announce('Describing scene.');
      // Stream the description so the first sentence is spoken as soon as the
      // model produces it, instead of after the whole reply returns. Guard
      // against critical alerts: this is the longest reply (max 160 tokens) and
      // runs mid-walk, so it is the most likely to be cut off by a STOP alert —
      // without the guard, still-arriving sentences would talk over the STOP.
      const speech = speakStream(() => alertRef.current.risk !== 'critical');
      const text = companionRef.current
        ? await companionSay('What do you see around us right now?', {
            snapshot: snapshotRef.current,
            withFrame: true,
            onDelta: (delta) => speech.push(delta),
          })
        : await describeCurrentScene(snapshotRef.current, (delta) => speech.push(delta));
      await speech.done();
      console.log(`[describe-scene] reply: "${text}"`);
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Unable to describe the scene.');
    }
  }, [active, announce]);
  const askCompanion = useCallback(
    async (text: string) => {
      console.log(`[companion] user said: "${text}"`);
      try {
        // The user spoke — cut off any ongoing narration immediately.
        await stopSpeaking();
        const now = Date.now();
        const recentEvents = journeyEventsRef.current
          .filter((entry) => now - entry.at < 90_000)
          .map((entry) => `${Math.round((now - entry.at) / 1000)}s ago: ${entry.event}`);
        // Stream the reply into incremental TTS: the first sentence starts
        // speaking ~1s after the user stops talking, while the model is still
        // generating the rest. The guard yields to a critical local obstacle
        // alert — if one fires mid-reply, further sentences are dropped so the
        // companion does not resume talking over a STOP alert.
        const speech = speakStream(() => alertRef.current.risk !== 'critical');
        const reply = await companionSay(text, {
          snapshot: snapshotRef.current,
          alert: alertRef.current,
          guidance: guidanceRef.current,
          events: recentEvents,
          // Walking companion: every voice turn gets fresh eyes while scanning.
          withFrame: active,
          onDelta: (delta) => speech.push(delta),
        });
        await speech.done();
        console.log(`[companion] reply: "${reply}"`);
      } catch (error) {
        console.warn('[companion] request failed:', error);
        announce('Companion is unavailable right now.');
      }
    },
    [active, announce],
  );

  const toggleAlertVoice = useCallback(() => {
    const next = !alertVoiceRef.current;
    alertVoiceRef.current = next;
    setAlertVoiceState(next);
    void speak(next ? 'Alert voice on.' : 'Alert voice off. Haptics stay on.', true);
  }, []);

  const toggleCompanion = useCallback(() => {
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
    toggleAlertVoice,
    askCompanion,
    companion,
    toggleCompanion,
    describeScene,
    alert,
    errorMessage,
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
