import type { LiveDebugFrame, NavigationGuidance, ObstacleSnapshot } from '../features/scanning/types';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useMemo, useState } from 'react';

type Route = NonNullable<ObstacleSnapshot['route']>;
type Point = { lateralM: number; forwardM: number };
type Size = { width: number; height: number };

type RouteDebugOverlayProps = {
  active: boolean;
  frame: LiveDebugFrame | null;
  guidance: NavigationGuidance;
  route: ObstacleSnapshot['route'];
};

const MAP_FORWARD_MAX_M = 3.2;
const MAP_LATERAL_MAX_M = 1.6;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function routePath(route: Route | undefined): Point[] {
  if (!route || route.status === 'unknown' || route.status === 'blocked') return [];
  return route.path && route.path.length >= 2 ? route.path : [];
}

function traceColor(route: Route | undefined): string {
  if (route?.status === 'clear' || route?.status === 'narrow') return '#2F80FF';
  return '#8E97A3';
}

function lineStyle(from: { x: number; y: number }, to: { x: number; y: number }, color: string) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

  return {
    left: (from.x + to.x) / 2 - length / 2,
    top: (from.y + to.y) / 2 - 2,
    width: Math.max(length, 2),
    backgroundColor: color,
    transform: [{ rotate: `${angle}deg` }],
  };
}

function mapPoint(point: Point, size: Size) {
  return {
    x:
      size.width / 2 +
      (clamp(point.lateralM, -MAP_LATERAL_MAX_M, MAP_LATERAL_MAX_M) /
        MAP_LATERAL_MAX_M) *
        (size.width / 2 - 14),
    y:
      size.height -
      (clamp(point.forwardM, 0, MAP_FORWARD_MAX_M) / MAP_FORWARD_MAX_M) *
        (size.height - 28) -
      10,
  };
}

function WorldTrace({ points, size, color }: { points: Point[]; size: Size; color: string }) {
  if (size.width === 0 || size.height === 0 || points.length < 2) return null;

  const projected = points.map((point) => mapPoint(point, size));
  return (
    <>
      {projected.slice(1).map((point, index) => (
        <View
          key={`world-line-${index}`}
          pointerEvents="none"
          style={[styles.traceLine, lineStyle(projected[index], point, color)]}
        />
      ))}
      {projected.map((point, index) => (
        <View
          key={`world-point-${index}`}
          pointerEvents="none"
          style={[styles.worldPoint, { left: point.x - 4, top: point.y - 4, backgroundColor: color }]}
        />
      ))}
    </>
  );
}

function WorldObstacles({ points, size }: { points: Point[]; size: Size }) {
  if (size.width === 0 || size.height === 0) return null;

  return points.map((point, index) => {
    const projected = mapPoint(point, size);
    return (
      <View
        key={`world-obstacle-${index}`}
        pointerEvents="none"
        style={[styles.worldObstacle, { left: projected.x - 3, top: projected.y - 3 }]}
      />
    );
  });
}

export function RouteDebugOverlay({ active, frame, guidance, route }: RouteDebugOverlayProps) {
  const [mapSize, setMapSize] = useState<Size>({ width: 0, height: 0 });
  const points = useMemo(() => routePath(route), [route]);
  const obstacles = (route?.obstacles ?? []).filter((point) =>
    point.forwardM >= 0 && point.forwardM <= MAP_FORWARD_MAX_M &&
    Math.abs(point.lateralM) <= MAP_LATERAL_MAX_M);
  const color = traceColor(route);
  const routeStatus = route?.status?.toUpperCase() ?? 'NO ROUTE';
  const hasTrace = points.length >= 2;
  const branchSummary = route?.branches?.length
    ? route.branches
        .slice(0, 2)
        .map((branch) => `${branch.direction.toUpperCase()} ${branch.distanceM.toFixed(1)} M`)
        .join(' · ')
    : 'NONE';

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <View>
          <Text maxFontSizeMultiplier={1.5} style={styles.eyebrow}>
            LIVE SPATIAL VIEW
          </Text>
          <Text maxFontSizeMultiplier={1.5} style={styles.title}>
            {active ? `${routeStatus} · ${guidance.source}` : 'START SCANNING'}
          </Text>
        </View>
        <View style={[styles.statusDot, { backgroundColor: hasTrace ? color : '#657080' }]} />
      </View>

      <View style={styles.cameraViewport}>
        {frame ? (
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            source={{ uri: frame.uri }}
            style={StyleSheet.absoluteFill}
          />
        ) : (
          <View style={styles.emptyCamera}>
            <Text maxFontSizeMultiplier={1.5} style={styles.emptyText}>
              Start scanning to see the camera, segmentation, and planned route.
            </Text>
          </View>
        )}
        <View pointerEvents="none" style={styles.cameraHud}>
          <View style={styles.hudBadge}>
            <View style={[styles.liveDot, active && styles.liveDotActive]} />
            <Text style={styles.hudText}>{active ? 'LIVE CAMERA' : 'CAMERA OFF'}</Text>
          </View>
          <View style={styles.hudBadge}>
            <View style={styles.pathSwatch} />
            <Text style={styles.hudText}>
              {frame?.floorDepthAvailable ? 'FLOOR · LIDAR' : 'FINDING FLOOR'}
            </Text>
          </View>
          <View style={styles.hudBadge}>
            <View style={styles.obstacleSwatch} />
            <Text style={styles.hudText}>
              {frame?.floorDepthAvailable ? 'OBJECT SURFACES' : 'DEPTH PENDING'}
            </Text>
          </View>
        </View>
        <View pointerEvents="none" style={styles.cameraGrid}>
          <View style={styles.cameraGridVertical} />
          <View style={styles.cameraGridHorizontal} />
        </View>
        <View pointerEvents="none" style={styles.guidanceOverlay}>
          <Text style={styles.guidanceLabel}>RECOMMENDED ROUTE</Text>
          <Text maxFontSizeMultiplier={1.4} style={styles.guidanceValue}>
            {guidance.instruction.replace('-', ' ').toUpperCase()}
          </Text>
        </View>
        <View style={styles.cameraLegend} pointerEvents="none">
          <Text style={styles.legendText}>{hasTrace ? 'BLUE FLOOR · RED OBJECT SURFACES' : 'NO CONFIRMED PATH'}</Text>
        </View>
      </View>

      <View
        onLayout={(event) =>
          setMapSize({
            width: event.nativeEvent.layout.width,
            height: event.nativeEvent.layout.height,
          })
        }
        style={styles.mapViewport}
      >
        <View pointerEvents="none" style={styles.mapCenterLine} />
        <View pointerEvents="none" style={styles.mapStart} />
        <WorldObstacles points={obstacles} size={mapSize} />
        <WorldTrace color={color} points={points} size={mapSize} />
        <Text pointerEvents="none" style={[styles.mapLabel, styles.mapLabelStart]}>
          PHONE
        </Text>
        <Text pointerEvents="none" style={[styles.mapLabel, styles.mapLabelAhead]}>
          3.2 M AHEAD
        </Text>
        <Text pointerEvents="none" style={[styles.mapLabel, styles.mapLabelLeft]}>
          LEFT
        </Text>
        <Text pointerEvents="none" style={[styles.mapLabel, styles.mapLabelRight]}>
          RIGHT
        </Text>
        {!hasTrace ? (
          <Text maxFontSizeMultiplier={1.4} style={styles.mapEmpty}>
            Waiting for enough observed free space
          </Text>
        ) : null}
      </View>

      <View style={styles.metrics}>
        <Metric label="TURN" value={route ? `${route.headingDeltaDeg.toFixed(0)}°` : '—'} />
        <Metric label="CLEARANCE" value={route?.minimumClearanceM != null ? `${route.minimumClearanceM.toFixed(2)} M` : '—'} />
        <Metric label="GOAL" value={route?.goalDistanceM != null ? `${route.goalDistanceM.toFixed(1)} M` : '—'} />
        <Metric label="CONFIDENCE" value={route ? `${Math.round(route.confidence * 100)}%` : '—'} />
      </View>
      <Text maxFontSizeMultiplier={1.4} style={styles.semanticDetail}>
        SEMANTIC RAY {route?.semanticHeadingDeg != null ? `${route.semanticHeadingDeg.toFixed(0)}°` : '—'}
        {'  ·  '}BRANCHES {branchSummary}
      </Text>
      <Text maxFontSizeMultiplier={1.4} style={styles.note}>
        Camera colors show measured floor and object surfaces. The map below shows the planned route.
        Uncolored areas have no confirmed floor measurement.
      </Text>
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text maxFontSizeMultiplier={1.4} style={styles.metricValue}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: 20,
    backgroundColor: 'rgba(11, 15, 19, 0.82)',
    borderWidth: 1,
    borderColor: '#38424D',
    padding: 14,
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  eyebrow: {
    color: '#F2FF63',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '900',
    letterSpacing: 1.4,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '800',
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  cameraViewport: {
    width: '100%',
    aspectRatio: 3 / 4,
    overflow: 'hidden',
    borderRadius: 14,
    backgroundColor: '#090A0C',
    borderWidth: 1,
    borderColor: '#2B343E',
  },
  emptyCamera: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  emptyText: {
    color: '#727B87',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    fontWeight: '600',
  },
  cameraGrid: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraHud: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  hudBadge: {
    minHeight: 28,
    borderRadius: 14,
    paddingHorizontal: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(8, 11, 14, 0.78)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.18)',
  },
  hudText: {
    color: '#FFFFFF',
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#697481',
  },
  liveDotActive: {
    backgroundColor: '#74F2A3',
  },
  pathSwatch: {
    width: 9,
    height: 9,
    borderRadius: 3,
    backgroundColor: '#2F80FF',
  },
  obstacleSwatch: {
    width: 9,
    height: 9,
    borderRadius: 3,
    backgroundColor: '#FF3232',
  },
  cameraGridVertical: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: 'rgba(242, 255, 99, 0.25)',
  },
  cameraGridHorizontal: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(242, 255, 99, 0.2)',
  },
  cameraLegend: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 9,
    alignItems: 'center',
  },
  guidanceOverlay: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 42,
    borderRadius: 13,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: 'rgba(8, 11, 14, 0.78)',
    borderWidth: 1,
    borderColor: 'rgba(242, 255, 99, 0.45)',
  },
  guidanceLabel: {
    color: '#BBC45A',
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '900',
    letterSpacing: 1,
  },
  guidanceValue: {
    color: '#FFFFFF',
    fontSize: 22,
    lineHeight: 27,
    fontWeight: '900',
  },
  legendText: {
    color: '#FFFFFF',
    backgroundColor: 'rgba(11, 13, 16, 0.75)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 5,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  traceLine: {
    position: 'absolute',
    height: 4,
    borderRadius: 2,
  },
  cameraPoint: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: '#0B0D10',
  },
  cameraObstacle: {
    position: 'absolute',
    backgroundColor: '#FF3232',
    borderWidth: 1,
    borderColor: '#FFFFFF',
    shadowColor: '#FF0000',
    shadowOpacity: 0.85,
    shadowRadius: 5,
  },
  mapViewport: {
    width: '100%',
    height: 190,
    overflow: 'hidden',
    borderRadius: 14,
    backgroundColor: '#0B1715',
    borderWidth: 1,
    borderColor: '#284A3A',
  },
  mapCenterLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: '50%',
    width: 1,
    backgroundColor: 'rgba(116, 242, 163, 0.18)',
  },
  mapStart: {
    position: 'absolute',
    bottom: 8,
    left: '50%',
    width: 14,
    height: 14,
    marginLeft: -7,
    borderRadius: 7,
    backgroundColor: '#FFFFFF',
    borderWidth: 3,
    borderColor: '#0B1715',
  },
  mapLabel: {
    position: 'absolute',
    color: '#6DAF88',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  mapLabelStart: {
    bottom: 7,
    left: '50%',
    marginLeft: 12,
  },
  mapLabelAhead: {
    top: 8,
    right: 10,
  },
  mapLabelLeft: {
    bottom: 8,
    left: 10,
  },
  mapLabelRight: {
    bottom: 8,
    right: 10,
  },
  mapEmpty: {
    position: 'absolute',
    left: 28,
    right: 28,
    top: '47%',
    color: '#6DAF88',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    fontWeight: '700',
  },
  worldPoint: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: '#0B1715',
  },
  worldObstacle: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FF3232',
  },
  metrics: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 7,
  },
  metric: {
    flex: 1,
    gap: 2,
  },
  metricLabel: {
    color: '#7D8996',
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  metricValue: {
    color: '#FFFFFF',
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
  },
  semanticDetail: {
    color: '#C7D2DE',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  note: {
    color: '#7D8996',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '600',
  },
});
