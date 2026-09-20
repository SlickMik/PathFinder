import ARKit
import CoreImage
import UIKit
import simd

struct LidarSessionOptions {
  let updateHz: Double
  let minimumConfidence: Int
  let maximumDistanceM: Double
  let corridorWidthM: Double
  let reactionTimeS: Double
}

final class LidarSession: NSObject, ARSessionDelegate {
  typealias Payload = [String: Any]

  private let session = ARSession()
  private let processingQueue = DispatchQueue(
    label: "com.pathfinder.lidar.processing",
    qos: .userInteractive
  )
  private let onSnapshot: (Payload) -> Void
  private let onError: (Payload) -> Void
  private var options = LidarSessionOptions(
    updateHz: 10,
    minimumConfidence: 1,
    maximumDistanceM: 4,
    corridorWidthM: 0.9,
    reactionTimeS: 1.5
  )
  private var processor = DepthProcessor()
  private var isRunning = false
  private var lastProcessedTimestamp: TimeInterval = 0
  private var lastCameraPosition: SIMD3<Float>?
  private var lastCameraForward: SIMD3<Float>?
  private var speedSamples: [Float] = []
  private var filteredSpeedMps: Float = 0
  private var floorHeight: Float?
  private var latestFrame: ARFrame?
  private let ciContext = CIContext()
  private var backgroundObserver: NSObjectProtocol?
  private var thermalObserver: NSObjectProtocol?

  init(onSnapshot: @escaping (Payload) -> Void, onError: @escaping (Payload) -> Void) {
    self.onSnapshot = onSnapshot
    self.onError = onError
    super.init()
    session.delegate = self
    session.delegateQueue = processingQueue

    backgroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.stopForSystemReason(
        code: "app-backgrounded",
        message: "Scanning stopped while PathFinder is in the background."
      )
    }

    thermalObserver = NotificationCenter.default.addObserver(
      forName: ProcessInfo.thermalStateDidChangeNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      guard ProcessInfo.processInfo.thermalState == .critical else { return }
      self?.stopForSystemReason(
        code: "thermal-pressure",
        message: "Scanning stopped because the device is too warm."
      )
    }
  }

  deinit {
    if let observer = backgroundObserver { NotificationCenter.default.removeObserver(observer) }
    if let observer = thermalObserver { NotificationCenter.default.removeObserver(observer) }
  }

  func start(options: LidarSessionOptions) throws {
    guard ARWorldTrackingConfiguration.isSupported else {
      throw LidarSessionException("AR world tracking is unavailable on this device.")
    }

    let configuration = ARWorldTrackingConfiguration()
    if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
      configuration.frameSemantics = .smoothedSceneDepth
    } else if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
      configuration.frameSemantics = .sceneDepth
    } else {
      throw LidarSessionException("This device does not provide LiDAR scene depth.")
    }

    configuration.planeDetection = [.horizontal, .vertical]
    configuration.environmentTexturing = .none

    processingQueue.sync {
      self.options = options
      self.processor = DepthProcessor()
      self.floorHeight = nil
      self.lastProcessedTimestamp = 0
      self.lastCameraPosition = nil
      self.lastCameraForward = nil
      self.speedSamples.removeAll(keepingCapacity: true)
      self.filteredSpeedMps = 0
      self.isRunning = true
      self.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
    }
  }

  func stop() {
    processingQueue.async { [weak self] in
      guard let self else { return }
      self.isRunning = false
      self.session.pause()
      self.latestFrame = nil
      self.processor.reset()
      self.floorHeight = nil
      self.lastCameraPosition = nil
      self.lastCameraForward = nil
      self.speedSamples.removeAll(keepingCapacity: true)
      self.filteredSpeedMps = 0
    }
  }

  // Reads the newest ARKit camera frame on the processing queue and returns a
  // downscaled JPEG. Nothing is retained after encoding.
  func captureFrame(maxDimension: Double, quality: Double) throws -> Payload {
    try processingQueue.sync {
      guard isRunning, let frame = latestFrame else {
        throw LidarSessionException("Camera is not running. Start scanning first.")
      }
      return try encodeFrame(
        frame,
        maxDimension: maxDimension,
        quality: quality,
        personMask: nil,
        surfaceMask: nil,
        includeDebugMetadata: false
      )
    }
  }

  /// Returns a lightweight preview frame with the same semantic masks used by
  /// the planner. Walkable surfaces are blue and obstacles are red. This stays
  /// separate from captureFrame so scene-description uploads receive a clean image.
  func captureDebugFrame(maxDimension: Double, quality: Double) throws -> Payload {
    try processingQueue.sync {
      guard isRunning, let frame = latestFrame else {
        throw LidarSessionException("Camera is not running. Start scanning first.")
      }
      return try encodeFrame(
        frame,
        maxDimension: maxDimension,
        quality: quality,
        personMask: nil,
        surfaceMask: depthDebugMask(for: frame),
        includeDebugMetadata: true
      )
    }
  }

  private func encodeFrame(
    _ frame: ARFrame,
    maxDimension: Double,
    quality: Double,
    personMask: PersonMask?,
    surfaceMask: WalkableSurfaceMask?,
    includeDebugMetadata: Bool
  ) throws -> Payload {
    // capturedImage is landscape-right; rotate so the image is upright in portrait.
    var image = normalizedOrigin(CIImage(cvPixelBuffer: frame.capturedImage).oriented(.right))
    if let surfaceMask {
      image = applyingSurfaceOverlay(to: image, mask: surfaceMask)
    }
    if let personMask {
      image = applyingPersonOverlay(to: image, mask: personMask)
    }

    let scale = min(1.0, maxDimension / Double(max(image.extent.width, image.extent.height)))
    if scale < 1 {
      image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    }

    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let jpeg = ciContext.jpegRepresentation(
            of: image,
            colorSpace: colorSpace,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: quality]
          ) else {
      throw LidarSessionException("Unable to encode camera frame.")
    }

    var payload: Payload = [
      "base64": jpeg.base64EncodedString(),
      "width": Int(image.extent.width),
      "height": Int(image.extent.height)
    ]
    if includeDebugMetadata {
      payload["segmentationAvailable"] = personMask != nil
      payload["pathSegmentationAvailable"] = false
      payload["floorDepthAvailable"] = surfaceMask != nil
      payload["personDetected"] = personMask?.containsPerson ?? false
    }
    return payload
  }

  /// Labels the actual depth pixels from this preview frame. The mask shares
  /// the captured camera's native orientation, then both rotate together.
  private func depthDebugMask(for frame: ARFrame) -> WalkableSurfaceMask? {
    guard let floorHeight, case .normal = frame.camera.trackingState,
          let data = frame.smoothedSceneDepth ?? frame.sceneDepth,
          let confidence = data.confidenceMap else { return nil }
    let depth = data.depthMap
    CVPixelBufferLockBaseAddress(depth, .readOnly)
    CVPixelBufferLockBaseAddress(confidence, .readOnly)
    defer {
      CVPixelBufferUnlockBaseAddress(depth, .readOnly)
      CVPixelBufferUnlockBaseAddress(confidence, .readOnly)
    }
    guard let depthBase = CVPixelBufferGetBaseAddress(depth),
          let confidenceBase = CVPixelBufferGetBaseAddress(confidence) else { return nil }
    let width = CVPixelBufferGetWidth(depth), height = CVPixelBufferGetHeight(depth)
    guard CVPixelBufferGetWidth(confidence) == width,
          CVPixelBufferGetHeight(confidence) == height else { return nil }
    let intrinsics = frame.camera.intrinsics
    let sx = Float(width) / Float(frame.camera.imageResolution.width)
    let sy = Float(height) / Float(frame.camera.imageResolution.height)
    let fx = intrinsics.columns.0.x * sx, fy = intrinsics.columns.1.y * sy
    let cx = intrinsics.columns.2.x * sx, cy = intrinsics.columns.2.y * sy
    guard fx > 0, fy > 0 else { return nil }
    var labels = [UInt8](repeating: 0, count: width * height)
    for y in 0..<height {
      let row = depthBase.advanced(by: y * CVPixelBufferGetBytesPerRow(depth)).assumingMemoryBound(to: Float.self)
      let confidenceRow = confidenceBase.advanced(by: y * CVPixelBufferGetBytesPerRow(confidence)).assumingMemoryBound(to: UInt8.self)
      for x in 0..<width {
        let d = row[x]
        guard d.isFinite, d >= 0.15, d <= Float(options.maximumDistanceM),
              confidenceRow[x] >= options.minimumConfidence else { continue }
        let world = frame.camera.transform * SIMD4<Float>((Float(x) - cx) * d / fx, -(Float(y) - cy) * d / fy, -d, 1)
        let heightAboveFloor = world.y - floorHeight
        if abs(heightAboveFloor) < 0.08 {
          labels[y * width + x] = WalkableSurfaceClass.covering.rawValue
        } else if heightAboveFloor > 0.08 && heightAboveFloor < 2 {
          labels[y * width + x] = WalkableSurfaceClass.curb.rawValue
        }
      }
    }
    return WalkableSurfaceMask(labels: labels, width: width, height: height, timestamp: frame.timestamp)
  }

  private func applyingPersonOverlay(to cameraImage: CIImage, mask: PersonMask) -> CIImage {
    applyingMaskOverlay(
      to: cameraImage,
      pixels: mask.pixels,
      width: mask.width,
      height: mask.height,
      color: CIColor(red: 1, green: 0.04, blue: 0.05, alpha: 0.68)
    )
  }

  private func applyingSurfaceOverlay(
    to cameraImage: CIImage,
    mask: WalkableSurfaceMask
  ) -> CIImage {
    var walkable = [UInt8](repeating: 0, count: mask.labels.count)
    var blocked = [UInt8](repeating: 0, count: mask.labels.count)
    for (index, label) in mask.labels.enumerated() {
      guard let surfaceClass = WalkableSurfaceClass(rawValue: label),
            let traversability = surfaceClass.traversability else { continue }
      if traversability > 0 {
        walkable[index] = UInt8(clamping: Int(145 + traversability * 90))
      } else if traversability < 0 {
        blocked[index] = 235
      }
    }

    var result = applyingMaskOverlay(
      to: cameraImage,
      pixels: walkable,
      width: mask.width,
      height: mask.height,
      color: CIColor(red: 0.06, green: 0.36, blue: 1, alpha: 0.42)
    )
    result = applyingMaskOverlay(
      to: result,
      pixels: blocked,
      width: mask.width,
      height: mask.height,
      color: CIColor(red: 1, green: 0.04, blue: 0.05, alpha: 0.54)
    )
    return result
  }

  private func applyingMaskOverlay(
    to cameraImage: CIImage,
    pixels: [UInt8],
    width: Int,
    height: Int,
    color: CIColor
  ) -> CIImage {
    let maskData = Data(pixels)
    var maskImage = CIImage(
      bitmapData: maskData,
      bytesPerRow: width,
      size: CGSize(width: width, height: height),
      format: .L8,
      colorSpace: CGColorSpaceCreateDeviceGray()
    )
    maskImage = normalizedOrigin(maskImage.oriented(.right))

    let scaleX = cameraImage.extent.width / max(maskImage.extent.width, 1)
    let scaleY = cameraImage.extent.height / max(maskImage.extent.height, 1)
    maskImage = maskImage
      .transformed(by: CGAffineTransform(scaleX: scaleX, y: scaleY))
      .cropped(to: cameraImage.extent)

    let overlayColor = CIImage(color: color).cropped(to: cameraImage.extent)
    let transparent = CIImage(
      color: CIColor(red: 0, green: 0, blue: 0, alpha: 0)
    ).cropped(to: cameraImage.extent)
    let overlay = overlayColor.applyingFilter(
      "CIBlendWithMask",
      parameters: [
        kCIInputBackgroundImageKey: transparent,
        kCIInputMaskImageKey: maskImage
      ]
    )
    return overlay.composited(over: cameraImage)
  }

  private func normalizedOrigin(_ image: CIImage) -> CIImage {
    image.transformed(
      by: CGAffineTransform(
        translationX: -image.extent.origin.x,
        y: -image.extent.origin.y
      )
    )
  }

  private func stopForSystemReason(code: String, message: String) {
    processingQueue.async { [weak self] in
      guard let self, self.isRunning else { return }
      self.isRunning = false
      self.session.pause()
      self.processor.reset()
      self.emitError(code: code, message: message, recoverable: false)
    }
  }

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    guard isRunning else { return }
    latestFrame = frame
    let minimumInterval = 1.0 / options.updateHz
    guard frame.timestamp - lastProcessedTimestamp >= minimumInterval else { return }
    let deltaTime = lastProcessedTimestamp == 0 ? minimumInterval : frame.timestamp - lastProcessedTimestamp
    lastProcessedTimestamp = frame.timestamp

    autoreleasepool {
      let tracking = trackingLabel(frame.camera.trackingState)
      let cameraTransform = frame.camera.transform
      let position = SIMD3<Float>(
        cameraTransform.columns.3.x,
        cameraTransform.columns.3.y,
        cameraTransform.columns.3.z
      )
      let forward = simd_normalize(SIMD3<Float>(
        -cameraTransform.columns.2.x,
        -cameraTransform.columns.2.y,
        -cameraTransform.columns.2.z
      ))
      let speedMps = movementSpeed(
        position: position,
        deltaTime: deltaTime,
        tracking: tracking
      )
      let aim = deviceAim(
        forward: forward,
        position: position,
        deltaTime: deltaTime,
        tracking: tracking
      )
      lastCameraPosition = position
      lastCameraForward = forward

      guard tracking == "normal", aim == "forward" else {
        emitSnapshot(
          processor.unknownSnapshot(tracking: tracking, aim: aim, speedMps: speedMps)
        )
        return
      }

      guard let depthData = frame.smoothedSceneDepth ?? frame.sceneDepth else {
        emitSnapshot(
          processor.unknownSnapshot(tracking: tracking, aim: aim, speedMps: speedMps)
        )
        return
      }

      let snapshot = processor.process(
        frame: frame,
        depthData: depthData,
        floorHeight: floorHeight,
        options: options,
        tracking: tracking,
        aim: aim,
        speedMps: speedMps
      )
      emitSnapshot(snapshot)
    }
  }

  func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
    updateFloorHeight(from: anchors)
  }

  func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
    updateFloorHeight(from: anchors)
  }

  func session(_ session: ARSession, didFailWithError error: Error) {
    guard isRunning else { return }
    isRunning = false
    emitError(code: "arkit-failure", message: error.localizedDescription, recoverable: false)
  }

  func sessionWasInterrupted(_ session: ARSession) {
    guard isRunning else { return }
    processor.reset()
    speedSamples.removeAll(keepingCapacity: true)
    filteredSpeedMps = 0
    emitError(
      code: "session-interrupted",
      message: "Tracking paused. Hold still and wait for the camera.",
      recoverable: true
    )
    emitSnapshot(
      processor.unknownSnapshot(
        tracking: "unavailable",
        aim: "unstable",
        speedMps: filteredSpeedMps
      )
    )
  }

  func sessionInterruptionEnded(_ session: ARSession) {
    guard isRunning else { return }
    processor.reset()
    lastProcessedTimestamp = 0
    lastCameraPosition = nil
    lastCameraForward = nil
    speedSamples.removeAll(keepingCapacity: true)
    filteredSpeedMps = 0
    session.run(session.configuration ?? ARWorldTrackingConfiguration(), options: [.resetTracking])
  }

  private func updateFloorHeight(from anchors: [ARAnchor]) {
    for case let plane as ARPlaneAnchor in anchors
      where plane.alignment == .horizontal && plane.classification == .floor {
      floorHeight = plane.transform.columns.3.y
    }
  }

  private func trackingLabel(_ state: ARCamera.TrackingState) -> String {
    switch state {
    case .normal: return "normal"
    case .limited: return "limited"
    case .notAvailable: return "unavailable"
    }
  }

  private func deviceAim(
    forward: SIMD3<Float>,
    position: SIMD3<Float>,
    deltaTime: TimeInterval,
    tracking: String
  ) -> String {
    guard tracking == "normal" else { return "unstable" }
    if forward.y > 0.42 { return "too-high" }
    if forward.y < -0.72 { return "too-low" }

    if let previousPosition = lastCameraPosition,
       let previousForward = lastCameraForward,
       deltaTime > 0 {
      let translationSpeed = simd_distance(position, previousPosition) / Float(deltaTime)
      let dotProduct = min(max(simd_dot(forward, previousForward), -1), 1)
      let angularSpeed = acos(dotProduct) / Float(deltaTime)
      if translationSpeed > 4.0 || angularSpeed > 2.2 { return "unstable" }
    }

    return "forward"
  }

  private func movementSpeed(
    position: SIMD3<Float>,
    deltaTime: TimeInterval,
    tracking: String
  ) -> Float {
    guard tracking == "normal",
          let previousPosition = lastCameraPosition,
          deltaTime > 0,
          deltaTime < 0.5 else {
      filteredSpeedMps *= 0.8
      return filteredSpeedMps < 0.04 ? 0 : filteredSpeedMps
    }

    let horizontalDelta = SIMD2<Float>(
      position.x - previousPosition.x,
      position.z - previousPosition.z
    )
    var rawSpeed = min(simd_length(horizontalDelta) / Float(deltaTime), 3.5)
    if rawSpeed < 0.06 { rawSpeed = 0 }

    speedSamples.append(rawSpeed)
    if speedSamples.count > 7 {
      speedSamples.removeFirst(speedSamples.count - 7)
    }
    let sorted = speedSamples.sorted()
    let medianSpeed = sorted[sorted.count / 2]
    let smoothing: Float = medianSpeed > filteredSpeedMps ? 0.5 : 0.22
    filteredSpeedMps += (medianSpeed - filteredSpeedMps) * smoothing
    if filteredSpeedMps < 0.04 { filteredSpeedMps = 0 }
    return filteredSpeedMps
  }

  private func emitSnapshot(_ payload: Payload) {
    DispatchQueue.main.async { [onSnapshot] in onSnapshot(payload) }
  }

  private func emitError(code: String, message: String, recoverable: Bool) {
    let payload: Payload = [
      "code": code,
      "message": message,
      "recoverable": recoverable
    ]
    DispatchQueue.main.async { [onError] in onError(payload) }
  }
}

private struct LidarSessionException: Error, LocalizedError {
  let message: String

  init(_ message: String) {
    self.message = message
  }

  var errorDescription: String? { message }
}
