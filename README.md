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
- Experimental ground-hazard alerts: below-floor evidence inside the walking corridor
  (descending stairs, ditches, kerb drops) and low leading obstacles in the trip band
  (wires, cords, kerbs), each confirmed across consecutive frames before speaking
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

Ground-hazard alerts are evidence-based and conservative: they only fire when the LiDAR
actually measures a surface well below the detected floor, or a distinct low obstacle,
with high confidence in the near field. They can miss hazards entirely (glass, water,
occlusion, absent returns) and must never replace a cane or guide dog for edge detection.

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

## AI companion backend (Gemini + ElevenLabs)

Deterministic LiDAR collision alerts run entirely on-device and never wait on the network. On
top of them, an optional zero-dependency Node proxy (`server/index.mjs`, Node 18+) uses Gemini
for multimodal understanding and ElevenLabs for natural voice output:

- `POST /describe-scene` — on-request Gemini scene descriptions grounded in compact on-device
  LiDAR, segmentation, and route context
- `POST /hazards` — structured hazard extraction with a strict JSON schema
- `POST /companion` — the "Path" walking companion, token-streamed over SSE so speech starts
  before the model finishes generating
- `POST /understand` — Gemini raw-audio transcription and multimodal reply — optional
- `GET /tts` — ElevenLabs natural voice — optional

The Gemini API key lives only on the server. The app answers reliable distance, direction, and
surface questions from on-device sensors first. Semantic questions send one deliberately captured
frame plus compact LiDAR/route facts — never a continuous video feed, segmentation mask, or raw
depth map. If Gemini is unavailable, scene requests fall back to a concise local sensor summary.
Upstream 429/5xx and connection failures are retried with exponential backoff and jitter
(honouring `Retry-After`); streamed replies are only retried before the first token reaches the
client.

Cloud AI is opt-in while this path is being stabilized. Leave `CLOUD_AI_ENABLED=false` in
`server/.env` (the default) for local-only navigation: no Gemini, ElevenLabs, camera upload, or
cloud companion request is made. Set `CLOUD_AI_ENABLED=true` and restart the development
supervisor to enable the Gemini and ElevenLabs routes; the supervisor passes the matching
`EXPO_PUBLIC_CLOUD_AI_ENABLED` flag to Expo automatically.

```sh
cp server/.env.example server/.env   # set GEMINI_API_KEY and optional voice keys
npm start                            # proxy + Metro, with the LAN URL injected automatically
npm run ios -- --device              # proxy + native build, also automatic
node server/e2e-test.mjs             # optional end-to-end check
```

The development launcher detects the Mac's current LAN address, starts the proxy on port 8787,
waits for `/health`, and injects `EXPO_PUBLIC_SCENE_DESCRIBE_URL` into Expo. The device and Mac
must be on the same network. Set `PATHFINDER_PROXY_HOST=127.0.0.1` to force Simulator routing,
or put an explicit `EXPO_PUBLIC_SCENE_DESCRIBE_URL` in the root `.env` to override detection.
Use `npm run start:expo` or `npm run ios:expo` only when you intentionally want Expo without the
proxy supervisor.

In a development client launched directly by Expo, the app can also derive the proxy host from
Metro at runtime. The proxy still needs to be running separately (`npm run server`), so the
supervised `npm start` / `npm run ios -- --device` commands remain the simplest path.

`EXPO_PUBLIC_COMPANION_URL` and `EXPO_PUBLIC_SCENE_APP_SECRET` are optional overrides; the
companion, hazard, and understand URLs are otherwise derived from the scene URL. Without a
backend the app degrades gracefully to on-device speech, alerts, and guidance.

## Checks

```sh
npm run typecheck
npm run lint
npm test
```

The distance thresholds are prototype defaults from `plan.md`; they have not been validated as
mobility-aid safety thresholds. Test stationary or at slow indoor speed with a sighted spotter.
