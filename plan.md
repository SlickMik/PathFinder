# LiDAR Mobility Assistant — Implementation Plan

## 1. Product goal

Build an iOS-first Expo app that acts as a supplemental “second pair of eyes” for a blind or low-vision user. Its core is a pedestrian collision-avoidance system inspired by the local perception loop in a self-driving car: continuously scan the space ahead, maintain a short-lived model of nearby obstacles, estimate what intersects the user’s near-term walking corridor, and communicate urgency and direction through haptics and concise audio. GPT-Live provides a conversational voice interface, while a delegated vision-capable backend describes selected camera views of the surrounding environment.

The goal is to reduce collisions, but software cannot guarantee that it will prevent one. This is an assistive aid, not a replacement for a cane, guide dog, orientation-and-mobility training, or the user’s own judgment. Unlike a self-driving car, the app cannot control the user’s motion or verify that a suggested direction is safe outside the sensor’s field of view. The first release must not claim to provide autonomous navigation, street-crossing guidance, or reliable drop-off/stair detection.

### MVP success criteria

- Starts and stops scanning with one accessible control.
- Announces whether the device supports LiDAR before scanning begins.
- Detects a solid obstacle in left, center, and right forward zones.
- Detects whether an obstacle intersects a configurable body-width walking corridor rather than warning equally about every visible object.
- Escalates warnings based on distance and, when motion estimates are reliable, time to possible contact.
- Reports stable distance bands rather than noisy frame-by-frame readings.
- Increases haptic urgency as the closest reliable obstacle approaches.
- Uses short, rate-limited audio cues for direction and critical warnings.
- Lets the user ask questions such as “What is around me?” and hear a concise scene description.
- Keeps deterministic LiDAR warnings active even when GPT-Live, the network, or the vision backend is unavailable.
- Remains usable with VoiceOver and without looking at the screen.
- Processes LiDAR depth locally and uploads camera frames only during an explicit scene-description session.
- Fails safely when tracking, confidence, or device support is inadequate.

## 2. Scope

### MVP

- iOS/iPadOS on LiDAR-capable devices.
- Forward obstacle awareness at walking speed.
- Three horizontal sectors: left, center, right.
- Four states: clear, caution, near, critical.
- Local pedestrian collision-risk estimation and immediate stop/left/center/right cues.
- Haptic feedback, optional speech/audio, and a minimal high-contrast interface.
- A GPT-Live voice session for interruptible, hands-free questions and answers.
- On-demand scene descriptions produced by a vision-capable Responses backend from selected camera frames.
- A short guided calibration and practice mode.
- On-device, anonymous diagnostic counters only when the user explicitly opts in.

### Later, only after user testing

- More precise spatial audio.
- Doorway/open-path suggestions.
- A denser ego-centric occupancy grid and short-horizon path scoring after the sector-based MVP is validated.
- Headphone and Apple Watch feedback.
- User-controlled automatic description intervals after on-demand descriptions are validated.
- Specialized reading, object-finding, and object-recognition modes.
- Android depth support using ARCore where suitable; it must be described as depth sensing rather than LiDAR.
- Carefully validated stair and drop-off detection.

### Explicitly out of scope for MVP

- Turn-by-turn navigation or map routing.
- Traffic-light, vehicle, or street-crossing decisions.
- Face recognition.
- Continuous video recording, unrestricted frame streaming, or hidden cloud inference.
- Background scanning.

## 3. Technical constraint and decision

Expo Go cannot load arbitrary native code. ARKit scene-depth access therefore requires:

1. An Expo development build.
2. A local Expo module written in Swift.
3. A physical LiDAR-capable Apple device for meaningful testing.

Use `ARWorldTrackingConfiguration` and enable `smoothedSceneDepth` when supported, otherwise `sceneDepth`. Always check `supportsFrameSemantics` before starting. Each depth-map value represents distance from the camera in meters, and the confidence map should be used to reject low-confidence samples.

Do not send complete depth maps across the React Native bridge. Process frames in Swift and emit a small summary at about 10 Hz. This reduces latency, memory churn, and battery use.

### GPT-Live and vision decision

Use GPT-Live as the full-duplex spoken conversation layer. GPT-Live can listen and speak at the same time and can delegate work to a backend agent. However, GPT-Live does not accept image input directly. For scene descriptions:

1. The app captures a deliberate, low-resolution camera frame.
2. The app sends that frame and the current compact LiDAR summary to a trusted backend.
3. A vision-capable model on the Responses API interprets the image.
4. The backend returns a short, uncertainty-aware description to GPT-Live.
5. GPT-Live speaks the result and remains interruptible if the user asks a follow-up.

Start with client delegation so the application controls exactly when a frame is captured, uploaded, discarded, and associated with a user request. Re-evaluate Responses delegation after prototyping. Keep the OpenAI project API key on the trusted server; never embed it in the Expo application.

## 4. Proposed architecture

```text
ARKit camera + LiDAR
        |
        v
Swift local Expo module
  - session lifecycle
  - depth/confidence filtering
  - obstacle clustering / local occupancy
  - walking-corridor intersection
  - left/center/right risk aggregation
  - temporal smoothing + hysteresis
        |
        | compact ObstacleSnapshot events (~10 Hz)
        v
TypeScript application
  - collision-risk policy/state machine
  - audio/haptic priority arbitration
  - settings and onboarding
  - accessible visual status
        |
        +--> expo-haptics
        +--> local/native urgent audio cues
        |
        +--> GPT-Live session (voice in/out)
                  |
                  | client delegation
                  v
             Trusted backend
               - session creation/auth
               - selected camera frame
               - compact LiDAR context
               - vision-capable Responses call
                  |
                  v
             concise visual finding
                  |
                  +--> GPT-Live spoken response
```

This follows a self-driving-style loop of perception → local world model → risk estimation → feedback, but stops before autonomous control. The LiDAR collision-avoidance loop and GPT-Live description loop are intentionally separate. Local obstacle alerts always have priority and must interrupt or duck a longer AI description.

### Suggested project layout

```text
app/
  _layout.tsx
  index.tsx                 # Ready/scanning screen
  onboarding.tsx
  settings.tsx
components/
  ScanControl.tsx
  StatusAnnouncement.tsx
  SectorStatus.tsx
features/scanning/
  alertPolicy.ts
  scanMachine.ts
  types.ts
  useLidarScanner.ts
features/assistant/
  liveSession.ts
  sceneDescription.ts
  useLiveAssistant.ts
  assistantPolicy.ts
modules/expo-lidar-vision/
  index.ts
  src/ExpoLidarVision.types.ts
  ios/ExpoLidarVisionModule.swift
  ios/LidarSession.swift
  ios/DepthProcessor.swift
  expo-module.config.json
config/
  thresholds.ts
server/
  live-session.ts            # Creates authenticated GPT-Live sessions
  describe-scene.ts          # Vision request orchestration
  prompts/
    liveAssistant.ts
    sceneDescription.ts
__tests__/
  alertPolicy.test.ts
  scanMachine.test.ts
  assistantPolicy.test.ts
```

## 5. Native module contract

Keep the JavaScript API small and versionable.

```ts
type LidarSupport = {
  supported: boolean;
  reason?: 'no-lidar' | 'unsupported-os' | 'permission-denied';
};

type SectorReading = {
  distanceM: number | null;
  confidence: 'low' | 'medium' | 'high';
  coverage: number; // 0...1, reliable samples / samples examined
};

type ObstacleSnapshot = {
  timestampMs: number;
  tracking: 'normal' | 'limited' | 'unavailable';
  deviceAim: 'forward' | 'too-high' | 'too-low' | 'unstable';
  left: SectorReading;
  center: SectorReading;
  right: SectorReading;
  corridor: {
    distanceM: number | null;
    timeToContactS: number | null;
    coverage: number;
    risk: 'clear' | 'caution' | 'near' | 'critical' | 'unknown';
  };
};

type LidarOptions = {
  updateHz: number;
  minimumConfidence: 'medium' | 'high';
  maximumDistanceM: number;
  corridorWidthM: number;
  reactionTimeS: number;
};

isSupported(): Promise<LidarSupport>;
requestPermission(): Promise<boolean>;
start(options: LidarOptions): Promise<void>;
stop(): Promise<void>;
addListener('onObstacleSnapshot', handler): Subscription;
addListener('onSessionError', handler): Subscription;
```

The native layer owns the AR session and image-size/orientation transforms. The TypeScript layer owns user preferences and alert behavior.

## 6. Pedestrian collision-avoidance approach

Model the core loop after the bounded local pipeline of an autonomous vehicle, adapted for a phone carried by a walking person:

```text
LiDAR perception
  → confidence filtering
  → short-lived local obstacle model
  → walking-corridor intersection
  → collision-risk estimate
  → haptic/audio feedback
```

This is local reactive assistance, not autonomous navigation. The app does not create a route, control movement, or certify that an opening is safe.

Start with a deliberately simple, testable algorithm:

1. Obtain `smoothedSceneDepth` when available.
2. Use camera intrinsics and the AR camera transform to convert sampled depth pixels into device- or world-relative 3D points.
3. Reject non-finite depths, readings outside the configured range, and samples below the minimum confidence.
4. Estimate device aim from ARKit pose and gravity. If the phone is pointed too high, too low, or is moving too erratically, report `deviceAim` and do not announce a direction as clear.
5. Remove the reliably estimated ground plane while retaining obstacles throughout the user’s collision envelope, including low boxes, poles, table edges, and head-height objects. Do not interpret missing floor depth as a safe drop-off result.
6. Maintain a short-lived ego-centric obstacle map. Merge consistent measurements across a few frames and rapidly expire stale points when the phone or obstacle moves.
7. Project a configurable body-width corridor forward from the user. Include a side margin for shoulders, cane/guide-dog space, phone-position error, and normal walking sway.
8. Divide the nearby scene into left, center, and right sectors for directional feedback, but assign the highest risk to obstacles that intersect the projected walking corridor.
9. For each region, compute a robust low percentile (for example the 15th percentile), not the absolute minimum, so one bad pixel does not create a warning.
10. Record reliable-sample coverage. Treat a region with insufficient coverage as unknown, never as clear.
11. Estimate closing speed and time to possible contact only from stable observations and reliable device motion. When this estimate is unreliable, set it to `null` and use conservative distance bands.
12. Apply rolling medians and hysteresis: entering a danger band should be fast, while leaving it should require several consistently safer readings.

### Risk model

Risk should combine:

- Whether the obstacle intersects the walking corridor.
- Nearest reliable distance.
- Closing speed and time to possible contact, when trustworthy.
- Obstacle width and vertical overlap with the user’s body envelope.
- Measurement coverage, depth confidence, tracking quality, and device aim.

The MVP may express this as a deterministic weighted score with explicit thresholds. Do not use GPT-Live or a generative model inside this immediate collision-risk loop.

Initial distance bands to validate—not ship as unquestioned constants:

| State    | Starting threshold | Feedback intent                          |
| -------- | -----------------: | ---------------------------------------- |
| Clear    |         over 2.0 m | No repeating feedback                    |
| Caution  |          1.2–2.0 m | Slow, light pulse                        |
| Near     |          0.6–1.2 m | Faster, stronger pulse                   |
| Critical |        under 0.6 m | Distinct urgent pattern plus short audio |

Thresholds must be configurable and tuned with blind/low-vision participants and orientation-and-mobility specialists. The app should prefer an “unknown / reposition phone” message over false reassurance.

### Guidance behavior

- `critical`: emit the strongest stop pattern immediately.
- `near`: identify the blocking direction and increase pulse frequency.
- `caution`: provide a slower directional cue without constant speech.
- If the center corridor is blocked and one side has better verified coverage, the app may describe that side as “more open,” never “safe.”
- If both sides are unknown or similarly blocked, say “Obstacle ahead—stop” rather than suggesting a turn.
- Do not issue left/right guidance based on a single frame or low-confidence opening.
- Re-evaluate after every significant phone turn; guidance from the previous heading becomes stale.

### Performance targets

- Summaries emitted at 8–12 Hz.
- Alert-state transition visible/audible within 250 ms of a reliable native summary.
- Critical collision warnings do not wait for a cloud request or GPT-Live response.
- The local obstacle model expires stale geometry within a tested, bounded window.
- No full-resolution depth or camera buffers retained after processing.
- Native processing should stay off the main thread.
- Reduce processing rate on thermal pressure, and stop with a clear message if a safe rate cannot be sustained.

## 7. Alert policy

Use a deterministic state machine, not component-level conditionals.

- Choose the highest-risk reliable sector.
- Prioritize obstacles intersecting the walking corridor; prefer the center sector when risks are otherwise equal.
- Use a distinct, unmistakable stop pattern for critical corridor conflicts.
- Do not speak every distance update.
- Announce direction when the highest-risk sector changes or when risk enters `near`/`critical`.
- Rate-limit non-critical speech; allow critical alerts to interrupt lower-priority speech.
- Stop all repeating cues immediately when scanning stops, the app backgrounds, or tracking becomes unavailable.
- When readings are unknown for a short window, pause obstacle cues and say “View blocked—reposition phone” once.

Suggested phrases are intentionally short: “Obstacle center,” “Obstacle left,” “Obstacle right,” “Very close,” and “Tracking paused.” Exact wording should be usability-tested.

## 8. GPT-Live scene descriptions

GPT-Live is the conversational interface, not the source of visual perception. The vision-capable backend examines selected still frames and returns grounded findings for GPT-Live to communicate.

### Initial user interactions

- “Describe what is in front of me.”
- “Where is the empty chair?”
- “Is there a door in view?”
- “Read the sign in front of me.” Reading mode may use a higher-resolution frame and a different prompt.
- “Say that again” or an immediate follow-up about the most recently analyzed frame.
- A dedicated “Describe surroundings” control for users who do not want an always-listening microphone.

### Request flow

1. The user presses the description control or asks GPT-Live for visual help.
2. The app plays a subtle capture cue and takes one current camera frame.
3. The app freezes the frame used for that request so a follow-up refers to the same view unless the user asks to refresh it.
4. The app attaches compact LiDAR context such as nearest reliable distance per sector, tracking quality, and frame timestamp. Never attach the full depth map.
5. The trusted backend sends the image, LiDAR context, and a task-specific prompt to a vision-capable Responses model.
6. The backend returns a concise result through the GPT-Live client-delegation result flow.
7. GPT-Live speaks the result. The user can interrupt, ask a follow-up, or request a fresh view.
8. The frame is deleted from application memory and temporary backend storage as soon as the request lifecycle allows.

### Description policy

The scene-description prompt should require the backend to:

- Lead with immediate, visually apparent hazards, then layout and useful landmarks.
- Use clock-face or left/center/right directions consistently.
- Use approximate distances only when supported by recent, reliable LiDAR context.
- Distinguish observation from inference: “I see a red octagonal sign” is safer than asserting its meaning when text is unreadable.
- State uncertainty briefly: “Possibly a glass door” or “I can’t confirm.”
- Never say a path, road, stairway, or crossing is safe.
- Avoid unnecessary visual detail unless the user asks for it.
- Avoid identifying or inferring sensitive personal traits about nearby people.
- Keep the first response short enough to preserve environmental awareness; expand only on request.

### Trigger and cadence policy

- MVP descriptions are on demand. Do not upload a continuous camera feed.
- Coalesce repeated requests while one vision request is in flight.
- Mark results stale when the phone has moved significantly or after a short timeout.
- Require a fresh frame before answering location-sensitive follow-ups after the result becomes stale.
- Cancel or deprioritize a description when a critical local LiDAR alert fires.
- If the network or backend is unavailable, say “Scene description unavailable” once while local LiDAR alerts continue.
- Provide an obvious Stop/Privacy control that closes the GPT-Live session, microphone, and pending uploads without stopping local LiDAR unless the user chooses to stop both.

### Audio coordination

- Deterministic local alerts have the highest audio priority.
- Critical LiDAR alerts interrupt GPT-Live speech immediately.
- Near alerts duck GPT-Live output; caution haptics may continue silently.
- GPT-Live should not narrate continuously or mask traffic and ambient sound.
- Prefer the phone speaker or open-ear audio; warn against audio configurations that block environmental hearing.

### Authentication and backend boundaries

- The mobile app requests a short-lived session from the trusted backend.
- The backend holds the OpenAI project API key and applies user/session authorization, rate limits, spend limits, and abuse controls.
- The app never receives a long-lived OpenAI API key.
- Log request IDs, latency, token/image usage, and coarse error categories—not raw frames, audio, transcripts, or descriptions by default.
- Treat all model output as untrusted advisory content before it reaches safety-sensitive application state. GPT output must never directly change LiDAR thresholds or suppress local alerts.

### Latency and cost targets

- Acknowledge the request locally within 150 ms.
- Target the first useful spoken scene description within 2 seconds on a healthy connection; measure rather than assume this target.
- Resize/compress frames to the lowest detail that still passes the evaluation suite.
- Use on-demand captures, short answers, response cancellation, and session timeouts to control usage.
- Show a clear network/AI activity indicator and expose usage limits in settings.

## 9. Accessible user experience

### Main screen

- One large button whose label and state are unambiguous: “Start obstacle alerts” / “Stop obstacle alerts.”
- One large “Describe surroundings” control and a separate, explicit control for starting or ending the GPT-Live conversation.
- A persistent text status: Ready, Scanning, Tracking limited, Unsupported, or Error.
- Separate local-sensing and online-assistant status so “AI unavailable” is never confused with “LiDAR stopped.”
- A visible three-sector indicator for sighted helpers and low-vision users; it is supplementary, not required for operation.
- High contrast, large Dynamic Type, no information conveyed by color alone, and reduced-motion support.

### VoiceOver

- Give every control a concise label, value, and hint.
- Use live announcements only for state changes, not every sensor frame.
- Keep focus stable when scanning begins.
- Never force users to navigate through the visual sector display.
- Announce frame capture, upload failure, stale descriptions, and GPT-Live connection changes without overwhelming obstacle cues.

### Onboarding

- State clearly that this is a supplemental aid.
- Confirm the device is supported and camera permission is granted.
- Teach the expected phone position and field of view.
- Include a stationary practice exercise with a sighted helper or known indoor obstacle.
- Let the user separately choose speech, haptics, and units.
- Explain exactly when camera frames and microphone audio leave the device, and demonstrate the Stop/Privacy control.

## 10. Safety and failure handling

- Do not label a direction “clear” unless it has enough recent high-quality depth coverage.
- Describe a direction as “more open” rather than “safe,” and only after multi-frame confirmation with adequate coverage.
- Pause warnings when AR tracking is limited or unavailable.
- Detect likely camera obstruction through persistently low coverage.
- Detect invalid phone aim and instruct the user to reposition the device instead of producing misleading guidance.
- Never infer that a drop-off, stair edge, glass surface, thin wire, fast-moving object, or space outside the camera field of view is absent merely because LiDAR did not detect it.
- Stop scanning when the app enters the background or receives an interruption.
- Stop GPT-Live audio and camera uploads independently when the user selects Stop/Privacy or when authorization expires.
- Never let an AI scene description downgrade, delay, or contradict a critical local obstacle warning.
- Label scene descriptions as potentially incomplete and stale; require fresh capture for time-sensitive questions.
- Do not use GPT-Live or vision output to make street-crossing, traffic, medication, identity, or other high-stakes decisions.
- Prevent the screen from sleeping only during an active session and make this behavior clear.
- Surface thermal and battery limitations without silently lowering reliability.
- Add an in-app safety statement and a first-run acknowledgement, but do not use the acknowledgement as a substitute for safe behavior.
- Conduct a privacy and accessibility review before any field study.
- Early tests should be stationary or slow indoor walkthroughs with a sighted spotter; no public-road testing in the MVP phase.

## 11. Privacy

- Process LiDAR depth entirely on device. Only compact sector distances and confidence summaries may be attached to a scene-description request.
- Upload a camera frame only after the user explicitly starts an online assistant session and requests a description. The capture cue must make each MVP upload perceptible.
- Stream microphone audio only while the GPT-Live session is visibly and accessibly active.
- Do not save frames, photos, point clouds, or room meshes.
- Configure the backend for ephemeral processing and verify current OpenAI API data-control and retention settings before beta. Document the actual policy in the app rather than promising zero retention without verification.
- Do not request location or contacts access for the MVP.
- Request microphone access only if the user enables the GPT-Live conversation; typed/button-driven descriptions must remain available without it.
- Avoid third-party analytics SDKs during prototyping.
- If diagnostics are later added, make them opt-in and limit them to coarse events such as session duration, error category, alert-state counts, description latency, and cancellation rate.
- Do not log raw images, depth maps, audio, transcripts, model descriptions, or bystander information by default.
- Provide deletion controls for any account-linked transcript or diagnostic data that is intentionally retained later.
- Document camera use in `NSCameraUsageDescription` in plain language.

## 12. Delivery phases

### Phase 0 — Discovery and safety definition

- Interview at least 3–5 blind/low-vision users and an orientation-and-mobility specialist.
- Identify preferred cue styles, phone placement, environments, and unacceptable failure modes.
- Write measurable safety claims and non-claims before coding detection features.

Exit: an agreed MVP scenario, safety boundary, and feedback vocabulary.

### Phase 1 — Expo shell

- Create a TypeScript Expo app with Expo Router.
- Add development-build support, haptics, camera/microphone permission copy, linting, and tests.
- Build the accessible ready/scanning UI using a fake sensor provider.
- Implement the alert state machine with deterministic fixtures.
- Build a fake GPT-Live/vision provider so assistant states can be tested without network access.

Exit: the complete interaction can be tested in a simulator without LiDAR.

### Phase 2 — Native LiDAR module

- Scaffold a local Expo module.
- Implement support checks, permission handling, session start/stop, and interruption handling.
- Process depth and confidence maps natively.
- Build the short-lived local obstacle model, walking corridor, and conservative collision-risk score.
- Emit corridor risk plus three-sector summaries and structured session errors.
- Add a developer-only overlay showing the corridor, obstacle points/clusters, sector distances, confidence, device aim, update rate, and tracking state.

Exit: a physical supported device produces stable measurements for static obstacles.

### Phase 3 — GPT-Live and vision foundation

- Create a minimal trusted backend for authenticated GPT-Live session creation; keep the OpenAI API key server-side.
- Connect GPT-Live audio using the supported mobile transport and verify interruption, cancellation, and session cleanup on a physical device.
- Implement client delegation from GPT-Live to the application backend.
- Add deliberate still-frame capture, image resizing/compression, compact LiDAR context, and a vision-capable Responses request.
- Return concise scene findings to GPT-Live for speech.
- Add Stop/Privacy, session timeout, spend/rate limits, and graceful offline behavior.
- Verify that local LiDAR alerts remain fully functional when every online component is disabled or failing.

Exit: the user can request one scene description, interrupt it, ask one grounded follow-up, and end the online session while local alerts continue.

### Phase 4 — Feedback integration

- Connect corridor risk and sector summaries to the TypeScript alert state machine.
- Add haptic patterns, urgent local audio cues, and audio-priority coordination with GPT-Live.
- Add settings for haptic/speech modes, sensitivity presets, and units.
- Validate pause/resume, permission denial, backgrounding, overheating, camera obstruction, offline mode, expired sessions, and backend timeouts.

Exit: all failure states are announced and no alert continues after scanning stops.

### Phase 5 — Structured validation

- Build a repeatable indoor obstacle course with measured distances and varied surfaces.
- Test bright, dim, reflective, absorptive, narrow, moving, and partially occluded obstacles at ankle, waist, chest, and head height.
- Include poles, table edges, open doors, glass, hanging objects, low boxes, approaching people, and obstacles entering from the side.
- Test while stationary, walking at several controlled speeds, turning the phone, and aiming it incorrectly.
- Measure detection distance, false alerts, missed corridor conflicts, incorrect opening guidance, time-to-contact error, end-to-end latency, and battery/thermal behavior.
- Create a consented scene-description evaluation set covering clutter, low light, glare, glass, text, people, doors, seating, stairs, and uncertain views.
- Measure description grounding, missed hazards, unsupported claims, stale-frame answers, time to first useful speech, interruption success, and network failure behavior.
- Run moderated usability sessions with blind/low-vision participants and a spotter.
- Change thresholds and cue policy based on recorded evidence.

Exit: MVP acceptance criteria pass and known limitations are documented in the app.

### Phase 6 — Beta hardening

- Add crash reporting only after a privacy review.
- Test supported device/OS combinations.
- Complete accessibility, privacy, and App Store metadata reviews.
- Verify OpenAI data controls, retention, current model availability, rate limits, and expected per-session cost against official documentation.
- Use TestFlight for a small supervised beta before broader distribution.

## 13. Test strategy

### Unit tests

- Distance-band boundaries.
- Corridor-intersection and body-envelope boundaries.
- Risk-score behavior with and without a reliable time-to-contact estimate.
- Sector tie-breaking.
- Rolling median and hysteresis.
- Unknown/low-coverage handling.
- Speech rate limiting and critical interruption.
- State transitions for permission, backgrounding, and session errors.
- Scene-description freshness and request coalescing.
- Audio priority: critical LiDAR alerts interrupt GPT-Live output.
- GPT-Live session state, cancellation, timeout, and offline fallbacks.

### Native tests

- Depth percentile calculation with recorded synthetic buffers.
- Confidence filtering and coverage calculation.
- Orientation/sector mapping.
- 3D unprojection, ground-plane handling, obstacle-map decay, and corridor intersection.
- Start/stop idempotence and resource cleanup.

### GPT-Live and vision tests

- API keys never appear in the app bundle, client logs, or source control.
- Session creation requires authenticated, authorized users and enforces rate/spend limits.
- The app uploads only after an explicit user request and emits the capture cue.
- A backend timeout, disconnect, rate limit, or malformed response cannot stop or weaken local LiDAR alerts.
- Vision answers cite only visible evidence and supplied LiDAR context in the evaluation fixtures.
- Prompts reject “safe to cross,” “path is clear,” identity, and sensitive-trait conclusions.
- Follow-ups use the intended frame and are rejected or refreshed after it becomes stale.
- Raw frames are absent from default server/application logs and temporary copies are removed as designed.
- The user can interrupt speech and close the online session reliably.

### Physical-device matrix

- Supported LiDAR device.
- Unsupported iPhone: clear unsupported experience, no crash.
- Camera permission denied/revoked.
- App background/foreground and phone call interruption.
- Headphones connected/disconnected.
- Airplane mode, poor connectivity, and mid-description network loss.
- GPT-Live session expiry and server rejection.
- Low Power Mode and thermal pressure.
- VoiceOver, Dynamic Type, Reduce Motion, and silent-mode combinations.

### MVP acceptance checks

- Detect a person-sized matte obstacle in each sector from 0.5–2.0 m in the defined indoor test setup.
- Detect the defined ankle-, waist-, chest-, and head-height corridor obstacles at the distances established by the supervised safety protocol.
- Never report `clear` when reliable coverage is below the specified minimum.
- Never recommend a side as more open from a single frame, stale map, invalid phone aim, or insufficient side coverage.
- Stop sensor capture and all cues within one second of Stop/background/error.
- Complete start/stop/settings flows with VoiceOver and no sighted assistance.
- Request, interrupt, repeat, and cancel a scene description without sighted assistance.
- Maintain local obstacle alerts through simulated GPT-Live and vision-backend failures.
- Produce no “safe,” identity, or sensitive-trait claims across the scene-description evaluation set.
- Run a 20-minute indoor session without a crash or unbounded memory growth.

These checks demonstrate the prototype’s bounded behavior; they do not establish medical-device or mobility-aid certification.

## 14. First implementation checklist

1. Initialize the Expo TypeScript project.
2. Install `expo-dev-client`, `expo-router`, `expo-haptics`, the camera/audio dependencies selected during implementation, and the project’s test/lint tools using `npx expo install` where applicable.
3. Add plain-language `NSCameraUsageDescription` and `NSMicrophoneUsageDescription` entries through app configuration.
4. Scaffold `modules/expo-lidar-vision` as a local Expo module.
5. Define the TypeScript contract and build a fake provider first.
6. Implement and test the alert state machine.
7. Build the accessible scanning UI against the fake provider.
8. Implement ARKit support checks and lifecycle in Swift.
9. Add native depth aggregation and confidence filtering.
10. Add 3D unprojection, the short-lived obstacle map, walking corridor, device-aim validation, and deterministic risk scoring.
11. Integrate on a physical LiDAR device and tune only from measured test data.
12. Build the trusted session backend and set server-side authentication, rate limits, and spend limits.
13. Add GPT-Live with client delegation and a fake vision backend first.
14. Add deliberate frame capture and a vision-capable Responses request with compact LiDAR context.
15. Implement audio interruption, Stop/Privacy, stale-frame, offline, and timeout behavior.
16. Evaluate descriptions and collision warnings against consented fixtures before any unsupervised field test.

## 15. Open decisions

- Minimum supported iOS/iPadOS version and exact device list.
- Handheld, chest-mounted, or lanyard usage model.
- Haptics-only feasibility when a cane occupies one hand.
- Whether stereo cues require headphones and how to preserve environmental hearing.
- Appropriate default thresholds for different walking speeds and phone positions.
- Body-corridor width, vertical collision envelope, side margin, map lifetime, and reaction-time presets.
- Whether handheld use is stable enough for collision guidance or whether a chest mount should be the recommended mode.
- Whether `sceneDepth` fallback is preferable to pausing when smoothed depth is unavailable.
- Research/ethics process required for participant testing.
- Which current vision-capable Responses model best balances grounding, latency, and cost; verify during implementation rather than hard-coding the plan to today’s default.
- Whether Responses delegation or client delegation performs better after the first controlled prototype.
- Whether microphone listening is push-to-talk, voice-activity based, or both.
- Frame resolution, compression, and freshness window needed for useful descriptions.
- Backend hosting region, authentication method, verified retention configuration, and operating budget.
- Whether users want strictly on-demand descriptions or an optional, visibly active periodic mode after MVP validation.
- App name; use “LiDAR” rather than “Lydar” in technical and store copy.

## 16. Primary references

- [Expo: Add custom native code](https://docs.expo.dev/workflow/customizing/)
- [Expo Modules API overview](https://docs.expo.dev/modules/overview/)
- [Expo: Development builds](https://docs.expo.dev/develop/development-builds/introduction/)
- [Apple: `ARFrame.sceneDepth`](https://developer.apple.com/documentation/arkit/arframe/scenedepth)
- [Apple: `ARDepthData`](https://developer.apple.com/documentation/arkit/ardepthdata)
- [Apple sample: Displaying a point cloud using scene depth](https://developer.apple.com/documentation/arkit/displaying-a-point-cloud-using-scene-depth)
- [OpenAI: Getting started with GPT-Live](https://developers.openai.com/api/docs/guides/live)
- [OpenAI: Delegation and tools in GPT-Live](https://developers.openai.com/api/docs/guides/live-delegation)
- [OpenAI: GPT-Live 1 model](https://developers.openai.com/api/docs/models/gpt-live-1)
