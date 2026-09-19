# PathFinder

PathFinder is an iOS-first Expo development-build prototype that uses ARKit scene depth to
provide local obstacle alerts. This implementation intentionally contains only the LiDAR
functionality described in `plan.md`: no microphone, cloud service, GPT session, camera upload,
or scene-description backend is included.

## What is implemented

- LiDAR capability and camera-permission checks
- `smoothedSceneDepth` with `sceneDepth` fallback
- Native confidence filtering and 15th-percentile distance aggregation
- A short-lived, world-space voxel map that expires after 450 ms
- Detected-floor removal, body-envelope filtering, three forward sectors, and walking-corridor risk
- Conservative unknown states for low coverage, invalid aim, or degraded AR tracking
- Stable TypeScript alert hysteresis and escalating haptic patterns
- VoiceOver-friendly controls, large Dynamic Type, and an explicit safety boundary
- Automatic sensor and alert shutdown when the app backgrounds or the device reaches critical heat

All depth processing remains inside the Swift module. Only compact distances, confidence,
coverage, tracking, aim, and risk values cross the React Native bridge.

## Run on a LiDAR device

Expo Go cannot load the Swift module. Use a physical LiDAR-capable iPhone or iPad and a
development build. Local native builds require Xcode and CocoaPods:

```sh
npm install
npx expo prebuild --platform ios --clean
npx expo run:ios --device
```

The project opts SDK 57 into Expo's iOS scene lifecycle support, which is required when
building with Xcode 27/iOS 27. Re-run the clean prebuild after changing native configuration.

For a shared device build, configure Apple signing and run `eas build --profile development
--platform ios`.

## Checks

```sh
npm run typecheck
npm run lint
npm test
```

The distance thresholds are prototype defaults from `plan.md`; they have not been validated as
mobility-aid safety thresholds. Test stationary or at slow indoor speed with a sighted spotter.
