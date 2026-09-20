# PathFinder

PathFinder is an iOS-first Expo development-build prototype that combines ARKit LiDAR depth,
on-device Vision person segmentation, and a local clearance-aware route planner to provide
short-range indoor guidance.

## What is implemented

- LiDAR capability and camera-permission checks
- `smoothedSceneDepth` with `sceneDepth` fallback
- Native confidence filtering and 15th-percentile distance aggregation
- A short-lived, world-space voxel map that expires after 450 ms
- Detected-floor removal, body-envelope filtering, three forward sectors, and walking-corridor risk
- Conservative unknown states for low coverage, invalid aim, or degraded AR tracking
- Stable TypeScript alert hysteresis and escalating haptic patterns
- Speed-adaptive warning distance using reaction and braking-distance calculations
- Stabilized local steering cues: straight, slight left/right, left/right, and stop
- A three-second, world-locked free-space map with conservative unknown-space handling
- Clearance-aware A* routing that inflates obstacles by body width plus a side margin
- Narrow-opening guidance that only accepts an observed gap wide enough for that envelope
- Optional Core ML walkable-surface segmentation projected into the world map with ARKit odometry
- A Mobilio-derived 0.2 m semantic grid with 181-ray heading search, gap tolerance, smoothing,
  and left/right branch detection, fused as a preference beneath LiDAR safety constraints
- Live camera debugging with a blue walkable-route overlay and red obstacle segmentation
- Apple's on-device person segmentation fused with LiDAR distance; person evidence expires quickly
- On-device spoken steering through the iOS speech synthesizer
- VoiceOver-friendly controls, large Dynamic Type, and an explicit safety boundary
- Automatic sensor and alert shutdown when the app backgrounds or the device reaches critical heat

Depth, CV, mapping, and route planning remain inside the Swift module. Only compact distances,
confidence, tracking, motion, risk, and route-guidance values cross the React Native bridge.

The planner is deliberately local (about three metres), not building-scale turn-by-turn routing.
It cannot guarantee that an opening, stair, drop-off, glass surface, or crossing is safe.

## Run on a LiDAR device

Expo Go cannot load the Swift module. Use a physical LiDAR-capable iPhone or iPad and a
development build. Local native builds require Xcode and CocoaPods:

```sh
npm install
npx pod-install ios
npx expo run:ios --device
```

Or open `ios/PathFinder.xcworkspace` in Xcode, select the PathFinder scheme and your connected
iPhone, set your Apple Development team under Signing & Capabilities, and press Run. Open the
workspace—not the `.xcodeproj`—so CocoaPods and the native LiDAR module are included.

Start scanning to open the live spatial view. Once ARKit detects the floor, the camera colors
measured floor pixels blue and body-height object surfaces red using that frame's LiDAR data.
The lower map shows the planned route and obstacles in phone-relative metres. The bundled outdoor
model is not trusted to classify indoor floors; trained compatible replacements can enable semantic
routing. Rebuild the app after changing native camera, segmentation, or route code.

The segmentation-to-guidance pipeline is implemented with a bundled Cityscapes/CamVid Core ML
baseline and a native adaptation of Mobilio's `Vision.cs` route logic. See
[walkable-path segmentation](docs/walkable-path-segmentation.md) for the model contract, porting
decisions, training recommendation, class mapping, and safety gates. Mobilio attribution and its
MIT license are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

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
