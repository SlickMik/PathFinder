export type Confidence = 'low' | 'medium' | 'high';
export type Risk = 'clear' | 'caution' | 'near' | 'critical' | 'unknown';
export type Sector = 'left' | 'center' | 'right';
export type Tracking = 'normal' | 'limited' | 'unavailable';
export type DeviceAim = 'forward' | 'too-high' | 'too-low' | 'unstable';
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
  route?: {
    instruction: NavigationInstruction;
    status: 'clear' | 'narrow' | 'blocked' | 'unknown';
    minimumClearanceM: number | null;
    openingWidthM: number | null;
    headingDeltaDeg: number;
    confidence: number;
    isNarrowOpening: boolean;
    goalDistanceM?: number;
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
  source: 'lidar-route' | 'reactive-sectors' | 'none';
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

export type CapturedFrame = {
  base64: string;
  width: number;
  height: number;
};

export type CameraTestFrame = CapturedFrame & {
  uri: string;
  capturedAtMs: number;
};
