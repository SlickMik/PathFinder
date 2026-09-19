export type Confidence = 'low' | 'medium' | 'high';
export type Risk = 'clear' | 'caution' | 'near' | 'critical' | 'unknown';
export type Sector = 'left' | 'center' | 'right';
export type Tracking = 'normal' | 'limited' | 'unavailable';
export type DeviceAim = 'forward' | 'too-high' | 'too-low' | 'unstable';

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
  left: SectorReading;
  center: SectorReading;
  right: SectorReading;
  corridor: {
    distanceM: number | null;
    timeToContactS: number | null;
    coverage: number;
    risk: Risk;
  };
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
