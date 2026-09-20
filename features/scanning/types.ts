export type Confidence = 'low' | 'medium' | 'high';
export type Risk = 'clear' | 'caution' | 'near' | 'critical' | 'unknown';
export type Sector = 'left' | 'center' | 'right';
export type Tracking = 'normal' | 'limited' | 'unavailable';
export type DeviceAim = 'forward' | 'too-high' | 'too-low' | 'unstable';
export type WalkableSurface =
  | 'terrain'
  | 'curb-cut'
  | 'sidewalk'
  | 'plain-crosswalk'
  | 'zebra-crosswalk'
  | 'covering'
  | 'doorway-opening';
export type NavigationInstruction =
  | 'hold'
  | 'stop'
  | 'straight'
  | 'slight-left'
  | 'left'
  | 'slight-right'
  | 'right';

export type LidarSupport = {
  supported: boolean;
  reason?: 'no-lidar' | 'unsupported-os' | 'permission-denied';
};

export type GroundHazardKind = 'drop-off' | 'trip-hazard';

export type DropOffReading = {
  detected: boolean;
  /** Forward distance to the nearest below-floor evidence, in metres. */
  distanceM: number | null;
  /** Observed depth below the detected floor, in metres. */
  depthM: number | null;
  sampleCount: number;
};

export type TripHazardReading = {
  detected: boolean;
  /** Forward distance to the nearest low obstacle, in metres. */
  distanceM: number | null;
  /** Observed height of the low obstacle above the floor, in metres. */
  heightM: number | null;
  sampleCount: number;
};

export type GroundHazards = {
  /** Hazard readings are only trustworthy once ARKit has classified a floor. */
  floorDetected: boolean;
  dropOff: DropOffReading;
  tripHazard: TripHazardReading;
};

export type SectorReading = {
  distanceM: number | null;
  confidence: Confidence;
  coverage: number;
};

export type ObstacleSnapshot = {
  timestampMs: number;
  tracking: Tracking;
  deviceAim: DeviceAim;
  motion: {
    speedMps: number;
  };
  left: SectorReading;
  center: SectorReading;
  right: SectorReading;
  corridor: {
    distanceM: number | null;
    timeToContactS: number | null;
    coverage: number;
    risk: Risk;
  };
  /** Ground-level hazards: drop-offs (stairs down, ditches) and trip hazards. */
  hazards?: GroundHazards;
  route?: {
    instruction: NavigationInstruction;
    status: 'clear' | 'narrow' | 'blocked' | 'unknown';
    minimumClearanceM: number | null;
    openingWidthM: number | null;
    headingDeltaDeg: number;
    confidence: number;
    isNarrowOpening: boolean;
    /** Whether the native path was constrained by semantic walkable-surface evidence. */
    source?: 'segmented-path' | 'lidar-route';
    surfaceClass?: WalkableSurface | null;
    goalDistanceM?: number;
    /** Mobilio-style smoothed semantic heading before LiDAR/A* safety fusion. */
    semanticHeadingDeg?: number | null;
    semanticPathLengthM?: number | null;
    /** Side openings detected along the accepted semantic path. */
    branches?: Array<{
      direction: 'left' | 'right';
      distanceM: number;
    }>;
    /** Shortest observed path in metres, relative to the phone. */
    path?: Array<{
      lateralM: number;
      forwardM: number;
    }>;
    /** Nearby LiDAR or semantic boundary cells, relative to the phone. */
    obstacles?: Array<{
      lateralM: number;
      forwardM: number;
    }>;
  };
};

export type SafetyEnvelope = {
  speedMps: number;
  reactionDistanceM: number;
  brakingDistanceM: number;
  warningDistanceM: number;
  criticalDistanceM: number;
  nearDistanceM: number;
};

export type NavigationGuidance = {
  instruction: NavigationInstruction;
  phrase: string | null;
  confidence: number;
  clearanceM: number | null;
  openingWidthM: number | null;
  isNarrowOpening: boolean;
  surfaceClass: WalkableSurface | null;
  source: 'segmented-path' | 'lidar-route' | 'reactive-sectors' | 'none';
  pendingInstruction: NavigationInstruction | null;
  pendingFrameCount: number;
};

export type LidarOptions = {
  updateHz: number;
  minimumConfidence: 'medium' | 'high';
  maximumDistanceM: number;
  corridorWidthM: number;
  reactionTimeS: number;
};

export type LidarSessionError = {
  code: string;
  message: string;
  recoverable: boolean;
};

export type ScannerStatus =
  | 'checking'
  | 'ready'
  | 'starting'
  | 'scanning'
  | 'paused'
  | 'unsupported'
  | 'permission-denied'
  | 'error';

export type AlertState = {
  risk: Risk;
  direction: Sector | null;
  saferFrameCount: number;
  unknownFrameCount: number;
  announcement: string | null;
};

export type GroundHazardAlertState = {
  active: GroundHazardKind | null;
  /** Latest forward distance to the active hazard, in metres. */
  distanceM: number | null;
  dropOffFrameCount: number;
  tripFrameCount: number;
  clearFrameCount: number;
  /** Phrase spoken the last time this hazard was announced. */
  lastSpokenPhrase: string | null;
  announcement: string | null;
};

export type CapturedFrame = {
  base64: string;
  width: number;
  height: number;
};

export type DebugFramePayload = CapturedFrame & {
  segmentationAvailable: boolean;
  pathSegmentationAvailable: boolean;
  floorDepthAvailable?: boolean;
  personDetected: boolean;
};

export type LiveDebugFrame = Omit<DebugFramePayload, 'base64'> & {
  uri: string;
  capturedAtMs: number;
};
