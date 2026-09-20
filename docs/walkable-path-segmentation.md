# Walkable-path segmentation

This implementation follows the perception-to-guidance structure in the 2026 Mobilio paper:

1. Segment the RGB camera frame into navigation-relevant surface classes.
2. Use ARKit visual-inertial odometry to project those labels onto a world-locked ground grid.
3. Search that grid for a short walkable route and convert its heading into straight, slight-left,
   slight-right, left, or right guidance.
4. Keep LiDAR obstacle mapping independent and give it authority over clearance and stopping.

This separation is important. A segmentation model can identify a sidewalk, but it cannot prove
that the sidewalk is free of a chair, person, drop-off, or glass panel.

## Should we train a lightweight model?

Yes, but fine-tune a pretrained lightweight segmenter rather than training one from scratch.
The paper used a normalized PP-MobileSeg-Tiny model at a 640×480 input and 160×120 output. Its
supplementary results report 51.90 mIoU and 96.42% pixel accuracy, essentially the same mIoU as
the much heavier DeepLabv3+ baseline (52.13) with higher pixel accuracy (90.80 for DeepLabv3+).
That is the right tradeoff for continuous on-device use.

Recommended order:

1. Fine-tune PP-MobileSeg-Tiny from pretrained weights using the nine-class mapping below.
2. Export to Core ML and benchmark on the target iPhone.
3. Only try a different backbone if conversion or Neural Engine compatibility is poor. A
   MobileNetV3 segmentation backbone is a reasonable fallback, but it should use the same output
   contract so the app code does not change.

Do not optimize only for mean IoU. Curb, curb-cut, and crosswalk recall matter more than a small
gain on common background pixels. Test motion blur, low light, shadows, wet pavement, snow,
construction, and phone tilt. Include local Toronto footage in the validation set.

## Core ML model contract

The repository currently bundles `PathSegmentation.mlmodel`, a small Tiramisu45 Cityscapes/CamVid
baseline. It supplies road and sidewalk evidence immediately. For the paper-aligned nine-class
model, replace it with your fine-tuned export at:

```text
modules/expo-lidar-vision/ios/PathSegmentation.mlmodel
```

Then run `npx pod-install ios` and rebuild the native app. The Swift module also accepts a compiled
`PathSegmentation.mlmodelc` in the main bundle. If no model is present or inference fails, the app
continues with LiDAR-only local routing.

The model should accept an RGB image. A 640×480 input and a 160×120 output match the paper, but the
runtime accepts other resolutions. Output either:

- a one-channel UInt8 pixel buffer containing class IDs; or
- an `MLMultiArray` label map, or logits shaped like `[1, 9, height, width]`.

The bundled 12-channel outdoor baseline is not validated for indoor floor recognition. Its labels
now remain unknown for routing; the previous road-to-floor reinterpretation produced false
walkable walls. A trained replacement should use this exact nine-class order:

| ID | Class | Planner treatment |
|---:|---|---|
| 0 | background | unknown |
| 1 | terrain | unknown / not used for routing |
| 2 | road | boundary unless a future crossing mode authorizes it |
| 3 | curb | boundary |
| 4 | curb cut | walkable |
| 5 | sidewalk | walkable |
| 6 | plain crosswalk | walkable |
| 7 | zebra crosswalk | walkable |
| 8 | covering | walkable |

For doorway navigation, add a tenth class at ID 9: `doorway-opening`. Train door leaves and
doorframes as boundary/background, and label only the visible traversable opening plus its floor
as `doorway-opening`. The runtime treats ID 9 as walkable evidence and reports
`surfaceClass: "doorway-opening"` when that class dominates the selected route. The gap still has
to pass the LiDAR clearance check; a visual opening alone can never authorize movement.

Road is intentionally conservative. The paper can combine surface perception with a navigation
route and crossing context; this app does not yet have that state, so treating every road pixel as
walkable would be unsafe.

## Runtime behavior

The camera debug overlay uses scene depth from the same displayed AR frame. Blue pixels are
within 8 cm of ARKit's detected floor; red pixels are observed surfaces 8 cm to 2 m above it.
Nothing is colored until a floor is detected. This is geometric floor detection, not a trained
indoor semantic model. The planned route is shown only on the top-down map: projecting that
2D route into the camera using distance-based screen coordinates was incorrect.

`WalkableSurfaceSegmenter.swift` schedules at most 10 inferences per second on a dedicated serial
queue and keeps all inference on device. LiDAR processing never waits for the model; it uses the
newest completed mask. `DepthProcessor.swift` projects candidate ground cells through the current
capture-time ARKit camera transform and samples the label mask. Masks older than one second are
discarded before projection. `LocalRoutePlanner.swift` temporally fuses the
near-field labels with LiDAR free-space evidence, rejects road and curb cells, inflates obstacles
by the body envelope, and runs Mobilio's alternating line search (0, +2, -2 degrees through
±90 degrees) over a two-metre corridor. The first fully observed, unblocked ray supplies steering;
A* supplies a curved route if none of those straight rays passes. Both searches reject diagonal
corner cutting and unknown cells. New obstacle returns override older free-space evidence.

`MobilioRouteAdvisor.swift` ports the useful navigation logic from Mobilio's Unity
`scripts/Vision.cs`: a 0.2 m world grid extending up to 15 m, strict/lax class handling, a
one-degree search across 180 degrees, two-cell DDA skip tolerance, five-metre minimum semantic
path by default (1.2 m in our indoor integration), 30-degree maximum target disparity,
four-sample weighted heading smoothing, one-second
validity, and median-based branch detection. Its result only biases the local A* goal; it cannot
override an occupied LiDAR cell or authorize unknown space. Detected surface transitions are
included with spoken steering, and semantic headings/branches are exposed in the debug panel.

The Unity-specific portions were intentionally replaced rather than copied: Sentis layer
scheduling became asynchronous Vision/Core ML inference, Unity transforms became ARKit camera
transforms, textures/compute-shader display became the Expo debug overlay, and recorded clips
became iOS text-to-speech. Mobilio's image-only fallback is unnecessary because this app retains
LiDAR sector guidance whenever the world-grid route is uncertain. Road and curb are also stricter
than upstream: neither is walkable without an explicit future crossing mode. Cached relative
headings are invalidated when the phone moves or turns.

The upstream revision inspected is `9dd54b80e95a48a95bde9d405ce6e632d66fbff9`.
`Navigation.cs` also implements GPS waypoint selection and calls an unpublished `WebClient`
for routes/intersections; `GPSData.cs` depends on unpublished compass/declination components.
Those destination-routing services and Mobilio's trained weights are not available in this
repository and are not implemented by this local indoor port. Spatial audio clips are also
absent; the app uses its existing spoken speaker guidance. This is an adaptation of the published
perception/avoidance algorithms, not a complete reproduction of the research application.

Run the native algorithm regression checks on macOS:

```sh
xcrun swiftc modules/expo-lidar-vision/ios/MobilioRouteAdvisor.swift modules/expo-lidar-vision/ios/LocalRoutePlanner.swift tests/native/MobilioTests.swift -o /tmp/pathfinder-mobilio-tests
/tmp/pathfinder-mobilio-tests
```

The route payload reports `source: "segmented-path"` only when enough current semantic and LiDAR
evidence overlap. Otherwise it reports `source: "lidar-route"`. Semantic evidence expires after
1.25 seconds so an old camera view cannot keep steering the user.

## Acceptance targets

Before using the model in a moving demo, require all of the following on the target phone:

- median inference under 100 ms and p95 under 150 ms;
- at least 5 segmentation updates per second while LiDAR continues at its configured rate;
- no thermal shutdown during a 10-minute walking test;
- curb/road false-walkable rate measured separately, not hidden inside aggregate accuracy;
- route-source fallback verified by removing the model and by forcing an inference error;
- stationary and slow-speed testing with a sighted spotter.

This remains a research prototype, not a replacement for a cane, guide dog, or certified mobility
aid.

## References

- Kuriakose et al., “Improving outdoor navigation for people with blindness using an AI-driven
  smartphone application and personalized audio guidance,” *Nature Biomedical Engineering*, 2026:
  https://www.nature.com/articles/s41551-026-01772-x
- Mobilio reference implementation: https://github.com/Harvard-Slade-Lab/Mobilio
- Supplementary evaluation tables:
  https://media.springernature.com/original/springer-static/esm/art:10.1038%2Fs41551-026-01772-x/MediaObjects/41551_2026_1772_MOESM1_ESM.pdf
