import ARKit
import AVFoundation
import ExpoModulesCore

struct LidarOptionsRecord: Record {
  @Field var updateHz: Double = 10
  @Field var minimumConfidence: String = "medium"
  @Field var maximumDistanceM: Double = 4
  @Field var corridorWidthM: Double = 0.9
  @Field var reactionTimeS: Double = 1.5
}

public final class ExpoLidarVisionModule: Module {
  private lazy var lidarSession = LidarSession(
    onSnapshot: { [weak self] snapshot in
      self?.sendEvent("onObstacleSnapshot", snapshot)
    },
    onError: { [weak self] error in
      self?.sendEvent("onSessionError", error)
    }
  )

  public func definition() -> ModuleDefinition {
    Name("ExpoLidarVision")

    Events("onObstacleSnapshot", "onSessionError")

    AsyncFunction("isSupported") { () -> [String: Any] in
      guard ARWorldTrackingConfiguration.isSupported else {
        return ["supported": false, "reason": "no-lidar"]
      }

      let supportsDepth =
        ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) ||
        ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
      guard supportsDepth else {
        return ["supported": false, "reason": "no-lidar"]
      }

      return ["supported": true]
    }

    AsyncFunction("requestPermission") { () async -> Bool in
      switch AVCaptureDevice.authorizationStatus(for: .video) {
      case .authorized:
        return true
      case .notDetermined:
        return await withCheckedContinuation { continuation in
          AVCaptureDevice.requestAccess(for: .video) { granted in
            continuation.resume(returning: granted)
          }
        }
      default:
        return false
      }
    }

    AsyncFunction("start") { (options: LidarOptionsRecord) in
      guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
        throw CameraPermissionException()
      }

      try self.lidarSession.start(
        options: LidarSessionOptions(
          updateHz: min(max(options.updateHz, 8), 12),
          minimumConfidence: options.minimumConfidence == "high" ? 2 : 1,
          maximumDistanceM: min(max(options.maximumDistanceM, 2), 6),
          corridorWidthM: min(max(options.corridorWidthM, 0.5), 1.6),
          reactionTimeS: min(max(options.reactionTimeS, 0.5), 3)
        )
      )
    }

    AsyncFunction("stop") {
      self.lidarSession.stop()
    }

    AsyncFunction("captureFrame") { (maxDimension: Double, quality: Double) -> [String: Any] in
      try self.lidarSession.captureFrame(
        maxDimension: min(max(maxDimension, 256), 1536),
        quality: min(max(quality, 0.3), 0.9)
      )
    }

    OnDestroy {
      self.lidarSession.stop()
    }
  }
}

private final class CameraPermissionException: Exception, @unchecked Sendable {
  override var reason: String {
    "Camera permission is required to access LiDAR depth."
  }
}
