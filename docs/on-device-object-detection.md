# On-device object detection recommendation

## Recommended model

Use **YOLO26n Detect exported as an INT8 Core ML model** and run it through Vision/Core ML on
selected `ARFrame.capturedImage` frames. The nano detector has 2.4 million fused parameters,
uses 5.5 GFLOPs at 640 pixels, supports Core ML export, and recognizes the 80 COCO classes.
It is currently the best fit when latency matters more than maximum detection accuracy.

Suggested export:

```sh
pip install ultralytics
yolo export model=yolo26n.pt format=coreml imgsz=640 quantize=8 nms=True
```

Load the compiled model with Vision and configure Core ML for `.cpuAndNeuralEngine`. Run object
detection at 4–6 Hz rather than on every 10 Hz LiDAR update so obstacle sensing retains priority.
Keep every camera frame and result on the device.

Ultralytics models are AGPL-3.0 by default. That is usually workable for an open-source
hackathon project, but a closed-source or commercial app needs an appropriate Ultralytics
commercial license. If that licensing does not fit, train an object detector with Create ML and
ship that Core ML model instead.

Sources:

- [YOLO26 model size and accuracy](https://docs.ultralytics.com/models/yolo26/)
- [YOLO26 Core ML export and deployment](https://docs.ultralytics.com/integrations/coreml/)
- [Apple Vision live object recognition](https://developer.apple.com/documentation/Vision/recognizing-objects-in-live-capture)
- [Ultralytics model licensing](https://www.ultralytics.com/license)

## Fuse labels with LiDAR distance

Do not use a detector's bounding-box size to guess distance. For each stable detection:

1. Transform its image bounding box into the scene-depth pixel coordinates for the current
   AR frame.
2. Sample the central portion of the box and reject low-confidence LiDAR pixels.
3. Use the median valid depth as object distance; the median is less sensitive to edges and
   background leakage than a single center pixel.
4. Intersect the box with the walking corridor and the current left/center/right sector.
5. Announce a label only after it persists across at least three detector results and its LiDAR
   distance is inside the current speed-adaptive warning distance.
6. Speak a compact phrase such as “Chair, slightly left, two metres.” Let urgent “Stop” and
   steering cues interrupt object labels.

The detector says *what* may be present; LiDAR remains the source of distance and immediate
collision risk. Unknown, reflective, transparent, thin, or partially visible objects can still be
missed, so object labels must never be treated as proof that a route is clear.
