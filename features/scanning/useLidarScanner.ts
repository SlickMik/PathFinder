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
import { describeCurrentScene } from '../speech/sceneDescriber';
import { speak, stopSpeaking } from '../speech/speech';
import { emitRiskHaptic, hapticIntervalMs } from './haptics';
import { safetyEnvelopeForSpeed } from './motionSafety';
import {
  INITIAL_NAVIGATION_GUIDANCE,
  planNavigation,
  reduceNavigationGuidance,
  surfacePhrase,
} from './navigation';
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
  const lastAnnouncementRef = useRef({ text: '', timestamp: 0 });
  const lastGuidanceSpeechRef = useRef({
    instruction: 'hold',
    surfaceClass: null as NavigationGuidance['surfaceClass'],
    timestamp: 0,
  });

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

      const viewValid =
        nextSnapshot.tracking === 'normal' && nextSnapshot.deviceAim === 'forward';
      setStatus(viewValid ? 'scanning' : 'paused');
      if (viewValid) setErrorMessage(null);

      if (nextAlert.announcement) {
        announce(nextAlert.announcement, nextAlert.risk === 'critical');
      }

      // Ground hazards interrupt regular obstacle chatter: a missed drop-off
      // is worse than a repeated obstacle warning.
      if (nextGroundHazard.announcement) {
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
    if (announceStop) void speak('Obstacle alerts stopped.');
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active' && active) void stop(false);
    });
    return () => subscription.remove();
  }, [active, stop]);

  // Ground hazards escalate the haptic pattern even when the corridor is
  // otherwise clear (a drop-off produces no forward obstacle return).
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
      setActive(true);
      setStatus('scanning');
      announce('Obstacle alerts started. Hold the phone upright and point it forward.');
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
      announce(await describeCurrentScene(), true);
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Unable to describe the scene.');
    }
  }, [active, announce]);

  return {
    active,
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
