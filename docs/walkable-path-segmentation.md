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

The bundled 12-channel baseline is mapped conservatively: its road channel becomes `road`, its
sidewalk channel becomes `sidewalk`, and all unsupported classes become `background`. A replacement
Mobilio-style model should use this exact nine-class order:

| ID | Class | Planner treatment |
|---:|---|---|
| 0 | background | unknown |
| 1 | terrain | weak walkable evidence |
| 2 | road | boundary unless a future crossing mode authorizes it |
| 3 | curb | boundary |
| 4 | curb cut | walkable |
| 5 | sidewalk | walkable |
| 6 | plain crosswalk | walkable |
| 7 | zebra crosswalk | walkable |
| 8 | covering | walkable |

Road is intentionally conservative. The paper can combine surface perception with a navigation
route and crossing context; this app does not yet have that state, so treating every road pixel as
walkable would be unsafe.

## Runtime behavior

`WalkableSurfaceSegmenter.swift` runs the model at most about 5.5 times per second and keeps all
inference on device. `DepthProcessor.swift` projects candidate ground cells through the current
ARKit camera transform and samples the label mask. `LocalRoutePlanner.swift` temporally fuses the
labels with LiDAR free-space evidence, rejects road and curb cells, inflates obstacles by the body
envelope, and runs A*.

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
