import { StyleSheet, Text, View } from 'react-native';
import type { DeviceAim, ScannerStatus, Tracking } from '../features/scanning/types';

type Props = {
  status: ScannerStatus;
  tracking?: Tracking;
  deviceAim?: DeviceAim;
  errorMessage?: string | null;
};

function statusCopy(status: ScannerStatus, tracking?: Tracking, deviceAim?: DeviceAim) {
  if (status === 'checking') return ['Checking device', 'Confirming LiDAR support.'];
  if (status === 'ready') return ['Ready', 'Obstacle alerts are off.'];
  if (status === 'starting') return ['Starting', 'Preparing the depth sensor.'];
  if (status === 'unsupported') return ['LiDAR unavailable', 'A LiDAR-capable iPhone or iPad is required.'];
  if (status === 'permission-denied') return ['Camera access needed', 'Allow camera access in Settings, then try again.'];
  if (status === 'error') return ['Scanner error', 'Obstacle alerts have stopped.'];
  if (status === 'paused') {
    if (tracking && tracking !== 'normal') return ['Tracking paused', 'Hold still and point the phone forward.'];
    if (deviceAim === 'too-high') return ['Aim lower', 'Point the phone toward the walking corridor.'];
    if (deviceAim === 'too-low') return ['Aim higher', 'Point the phone toward the walking corridor.'];
    return ['Reposition phone', 'Hold the phone steady and point it forward.'];
  }
  return ['Scanning', 'Local obstacle alerts are active.'];
}

export function StatusAnnouncement({ status, tracking, deviceAim, errorMessage }: Props) {
  const [title, detail] = statusCopy(status, tracking, deviceAim);
  const active = status === 'scanning';

  return (
    <View
      accessibilityRole="summary"
      accessibilityLabel={`${title}. ${errorMessage ?? detail}`}
      style={[styles.container, active && styles.activeContainer]}
    >
      <View style={[styles.dot, active && styles.activeDot]} />
      <View style={styles.copy}>
        <Text maxFontSizeMultiplier={1.8} style={styles.title}>
          {title}
        </Text>
        <Text maxFontSizeMultiplier={1.8} style={styles.detail}>
          {errorMessage ?? detail}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderWidth: 1,
    borderColor: '#303742',
    backgroundColor: '#171B21',
    borderRadius: 18,
    padding: 18,
  },
  activeContainer: {
    borderColor: '#B8C147',
  },
  dot: {
    width: 13,
    height: 13,
    marginTop: 6,
    borderRadius: 7,
    backgroundColor: '#77808D',
  },
  activeDot: {
    backgroundColor: '#F2FF63',
  },
  copy: {
    flex: 1,
    gap: 3,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 19,
    lineHeight: 24,
    fontWeight: '800',
  },
  detail: {
    color: '#B7BEC8',
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '500',
  },
});
