import { DEFAULT_LIDAR_OPTIONS } from '../../config/thresholds';
import { ExpoLidarVision } from '../../modules/expo-lidar-vision';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';
import { INITIAL_ALERT_STATE, reduceAlertState } from './alertPolicy';
import { emitRiskHaptic, hapticIntervalMs } from './haptics';
import type {
  AlertState,
  LidarSupport,
  ObstacleSnapshot,
  ScannerStatus,
} from './types';

const KEEP_AWAKE_TAG = 'pathfinder-lidar-session';

export function useLidarScanner() {
  const [support, setSupport] = useState<LidarSupport | null>(null);
  const [status, setStatus] = useState<ScannerStatus>('checking');
  const [active, setActive] = useState(false);
  const [snapshot, setSnapshot] = useState<ObstacleSnapshot | null>(null);
  const [alert, setAlert] = useState<AlertState>(INITIAL_ALERT_STATE);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const alertRef = useRef(INITIAL_ALERT_STATE);
  const lastAnnouncementRef = useRef({ text: '', timestamp: 0 });

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
    AccessibilityInfo.announceForAccessibility(text);
  }, []);

  useEffect(() => {
    const snapshotSubscription = ExpoLidarVision.onSnapshot((nextSnapshot) => {
      setSnapshot(nextSnapshot);

      const nextAlert = reduceAlertState(alertRef.current, nextSnapshot);
      alertRef.current = nextAlert;
      setAlert(nextAlert);

      const viewValid =
        nextSnapshot.tracking === 'normal' && nextSnapshot.deviceAim === 'forward';
      setStatus(viewValid ? 'scanning' : 'paused');
      if (viewValid) setErrorMessage(null);

      if (nextAlert.announcement) {
        announce(nextAlert.announcement, nextAlert.risk === 'critical');
      }
    });

    const errorSubscription = ExpoLidarVision.onError((error) => {
      alertRef.current = INITIAL_ALERT_STATE;
      setAlert(INITIAL_ALERT_STATE);
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
  }, [announce]);

  const stop = useCallback(async (announceStop = true) => {
    await ExpoLidarVision.stop();
    setActive(false);
    setSnapshot(null);
    alertRef.current = INITIAL_ALERT_STATE;
    setAlert(INITIAL_ALERT_STATE);
    setStatus((current) => (current === 'unsupported' ? current : 'ready'));
    deactivateKeepAwake(KEEP_AWAKE_TAG);
    if (announceStop) AccessibilityInfo.announceForAccessibility('Obstacle alerts stopped.');
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

  useEffect(
    () => () => {
      void ExpoLidarVision.stop();
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

  return {
    active,
    alert,
    errorMessage,
    snapshot,
    start,
    status,
    stop,
    support,
  };
}
