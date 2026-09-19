import ARKit
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
  private var floorHeight: Float?
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

    configuration.planeDetection = [.horizontal]
    configuration.environmentTexturing = .none

    processingQueue.sync {
      self.options = options
      self.processor = DepthProcessor()
      self.floorHeight = nil
      self.lastProcessedTimestamp = 0
      self.lastCameraPosition = nil
      self.lastCameraForward = nil
      self.isRunning = true
      self.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
    }
  }

  func stop() {
    processingQueue.async { [weak self] in
      guard let self else { return }
      self.isRunning = false
      self.session.pause()
      self.processor.reset()
      self.floorHeight = nil
      self.lastCameraPosition = nil
      self.lastCameraForward = nil
    }
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
      let aim = deviceAim(
        forward: forward,
        position: position,
        deltaTime: deltaTime,
        tracking: tracking
      )
      lastCameraPosition = position
      lastCameraForward = forward

      guard tracking == "normal", aim == "forward" else {
        emitSnapshot(processor.unknownSnapshot(tracking: tracking, aim: aim))
        return
      }

      guard let depthData = frame.smoothedSceneDepth ?? frame.sceneDepth else {
        emitSnapshot(processor.unknownSnapshot(tracking: tracking, aim: aim))
        return
      }

      let snapshot = processor.process(
        frame: frame,
        depthData: depthData,
        floorHeight: floorHeight,
        options: options,
        tracking: tracking,
        aim: aim
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
    emitError(
      code: "session-interrupted",
      message: "Tracking paused. Hold still and wait for the camera.",
      recoverable: true
    )
    emitSnapshot(processor.unknownSnapshot(tracking: "unavailable", aim: "unstable"))
  }

  func sessionInterruptionEnded(_ session: ARSession) {
    guard isRunning else { return }
    processor.reset()
    lastProcessedTimestamp = 0
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
      if translationSpeed > 2.4 || angularSpeed > 2.2 { return "unstable" }
    }

    return "forward"
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
