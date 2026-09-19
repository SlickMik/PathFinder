import { requireOptionalNativeModule } from 'expo';
import type { ExpoLidarVisionNativeModule } from './ExpoLidarVision.types';

export default requireOptionalNativeModule<ExpoLidarVisionNativeModule>(
  'ExpoLidarVision',
);
