import ARKit
import CoreML
import CoreVideo
import Foundation
import ImageIO
import Vision

enum WalkableSurfaceClass: UInt8 {
  case background = 0
  case terrain = 1
  case road = 2
  case curb = 3
  case curbCut = 4
  case sidewalk = 5
  case plainCrosswalk = 6
  case zebraCrosswalk = 7
  case covering = 8
  case doorwayOpening = 9

  var name: String {
    switch self {
    case .background: return "background"
    case .terrain: return "terrain"
    case .road: return "road"
    case .curb: return "curb"
    case .curbCut: return "curb-cut"
    case .sidewalk: return "sidewalk"
    case .plainCrosswalk: return "plain-crosswalk"
    case .zebraCrosswalk: return "zebra-crosswalk"
    case .covering: return "covering"
    case .doorwayOpening: return "doorway-opening"
    }
  }

  /// Positive values are walkable evidence and negative values are boundaries.
  /// Background stays unknown, and road is deliberately not considered walkable
  /// unless a future navigation state explicitly authorizes a road crossing.
  var traversability: Float? {
    switch self {
    case .sidewalk, .curbCut, .plainCrosswalk, .zebraCrosswalk, .covering, .doorwayOpening:
      return 1
    case .road, .curb:
      return -1
    case .background, .terrain:
      return nil
    }
  }

  /// Mobilio's strict classes are used to establish that the camera has found
  /// an actual travel surface. Indoor covering and trained doorway openings
  /// are included as PathFinder-specific extensions.
  var strictWalkable: Bool {
    switch self {
    case .sidewalk, .plainCrosswalk, .zebraCrosswalk, .covering, .doorwayOpening:
      return true
    default:
      return false
    }
  }

  /// Mobilio allows curb pixels in its tolerant ray-cast. We deliberately do
  /// not: a curb remains a hard semantic boundary until LiDAR and a future
  /// crossing state can prove that it is safe.
  var laxWalkable: Bool {
    switch self {
    case .curbCut, .sidewalk, .plainCrosswalk, .zebraCrosswalk, .covering, .doorwayOpening:
      return true
    default:
      return false
    }
  }

  static func fromModelClass(_ rawValue: Int, channelCount: Int) -> WalkableSurfaceClass {
    // The outdoor baseline has no validated indoor floor/doorway mapping.
    // Do not reinterpret road logits as floor or let them authorize movement.
    if channelCount == 12 {
      return .background
    }
    return WalkableSurfaceClass(rawValue: UInt8(clamping: rawValue)) ?? .background
  }
}

struct WalkableSurfaceMask {
  let labels: [UInt8]
  let width: Int
  let height: Int
  let timestamp: TimeInterval
  var cameraTransform: simd_float4x4?
  var cameraIntrinsics: simd_float3x3?
  var imageResolution: CGSize?

  func surfaceClass(
    imageX: Float,
    imageY: Float,
    imageWidth: Float,
    imageHeight: Float
  ) -> WalkableSurfaceClass? {
    guard imageWidth > 0, imageHeight > 0, width > 0, height > 0,
          imageX >= 0, imageY >= 0, imageX < imageWidth, imageY < imageHeight else {
      return nil
    }
    let x = min(width - 1, max(0, Int(imageX / imageWidth * Float(width))))
    let y = min(height - 1, max(0, Int(imageY / imageHeight * Float(height))))
    return WalkableSurfaceClass(rawValue: labels[y * width + x])
  }
}

/// Optional Core ML walkable-surface segmentation. The LiDAR stream remains
/// fully functional when no model is bundled or an inference fails.
final class WalkableSurfaceSegmenter {
  private let lock = NSLock()
  private let inferenceQueue = DispatchQueue(
    label: "com.pathfinder.walkable-segmentation",
    qos: .userInitiated
  )
  private var lastMask: WalkableSurfaceMask?
  private var lastRun: TimeInterval = -.infinity
  private var inferenceRunning = false
  private var generation = 0
  private let minimumInterval: TimeInterval = 0.10
  private let model: VNCoreMLModel?

  init() {
    model = Self.loadModel()
  }

  func reset() {
    lock.lock()
    defer { lock.unlock() }
    generation += 1
    lastMask = nil
    lastRun = -.infinity
    inferenceRunning = false
  }

  func currentMask() -> WalkableSurfaceMask? {
    lock.lock()
    defer { lock.unlock() }
    return lastMask
  }

  func mask(for frame: ARFrame) -> WalkableSurfaceMask? {
    guard let model else { return nil }

    lock.lock()
    let cachedMask = lastMask
    guard !inferenceRunning, frame.timestamp - lastRun >= minimumInterval else {
      lock.unlock()
      return cachedMask
    }
    inferenceRunning = true
    lastRun = frame.timestamp
    let activeGeneration = generation
    lock.unlock()

    let pixelBuffer = frame.capturedImage
    let timestamp = frame.timestamp
    let transform = frame.camera.transform
    let intrinsics = frame.camera.intrinsics
    let resolution = frame.camera.imageResolution
    inferenceQueue.async { [weak self] in
      let request = VNCoreMLRequest(model: model)
      request.imageCropAndScaleOption = .scaleFill
      var nextMask: WalkableSurfaceMask?
      do {
        // ARKit's captured buffer and scene-depth buffer use the same native
        // landscape camera coordinate space, so keep both unrotated here.
        try VNImageRequestHandler(
          cvPixelBuffer: pixelBuffer,
          orientation: .up
        ).perform([request])
        nextMask = Self.mask(from: request.results, timestamp: timestamp)
        nextMask?.cameraTransform = transform
        nextMask?.cameraIntrinsics = intrinsics
        nextMask?.imageResolution = resolution
      } catch {
        // Semantic inference must never interrupt the higher-priority LiDAR loop.
      }

      guard let self else { return }
      self.lock.lock()
      if self.generation == activeGeneration {
        if let nextMask { self.lastMask = nextMask }
        self.inferenceRunning = false
      }
      self.lock.unlock()
    }
    return cachedMask
  }

  private static func loadModel() -> VNCoreMLModel? {
    let configuration = MLModelConfiguration()
    configuration.computeUnits = .all
    let bundles = [Bundle.main, Bundle(for: WalkableSurfaceSegmenter.self)]

    for bundle in bundles {
      if let compiledURL = bundle.url(forResource: "PathSegmentation", withExtension: "mlmodelc"),
         let mlModel = try? MLModel(contentsOf: compiledURL, configuration: configuration),
         let visionModel = try? VNCoreMLModel(for: mlModel) {
        return visionModel
      }
      if let sourceURL = bundle.url(forResource: "PathSegmentation", withExtension: "mlmodel"),
         let compiledURL = try? MLModel.compileModel(at: sourceURL),
         let mlModel = try? MLModel(contentsOf: compiledURL, configuration: configuration),
         let visionModel = try? VNCoreMLModel(for: mlModel) {
        return visionModel
      }
    }
    return nil
  }

  private static func mask(
    from observations: [VNObservation]?,
    timestamp: TimeInterval
  ) -> WalkableSurfaceMask? {
    guard let observations else { return nil }
    for observation in observations {
      if let pixelObservation = observation as? VNPixelBufferObservation,
         let mask = copyPixelMask(pixelObservation.pixelBuffer, timestamp: timestamp) {
        return mask
      }
      if let featureObservation = observation as? VNCoreMLFeatureValueObservation,
         let array = featureObservation.featureValue.multiArrayValue,
         let mask = copyMultiArrayMask(array, timestamp: timestamp) {
        return mask
      }
    }
    return nil
  }

  private static func copyPixelMask(
    _ buffer: CVPixelBuffer,
    timestamp: TimeInterval
  ) -> WalkableSurfaceMask? {
    guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_OneComponent8 else {
      return nil
    }
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
    var labels = [UInt8](repeating: 0, count: width * height)
    labels.withUnsafeMutableBufferPointer { destination in
      for y in 0..<height {
        let source = base.advanced(by: y * rowBytes).assumingMemoryBound(to: UInt8.self)
        destination.baseAddress!.advanced(by: y * width).update(from: source, count: width)
      }
    }
    return WalkableSurfaceMask(labels: labels, width: width, height: height, timestamp: timestamp)
  }

  private static func copyMultiArrayMask(
    _ array: MLMultiArray,
    timestamp: TimeInterval
  ) -> WalkableSurfaceMask? {
    let shape = array.shape.map { Int(truncating: $0) }
    let strides = array.strides.map { Int(truncating: $0) }
    guard shape.count >= 2 else { return nil }

    let heightIndex = shape.count - 2
    let widthIndex = shape.count - 1
    let height = shape[heightIndex]
    let width = shape[widthIndex]
    guard height > 0, width > 0 else { return nil }

    let channelIndex = shape.count >= 3 ? shape.count - 3 : nil
    let channelCount = channelIndex.map { shape[$0] } ?? 1
    var labels = [UInt8](repeating: 0, count: width * height)

    for y in 0..<height {
      for x in 0..<width {
        var bestClass = 0
        if channelCount > 1 {
          var bestScore = -Double.greatestFiniteMagnitude
          for channel in 0..<channelCount {
            let offset = channel * strides[channelIndex!]
              + y * strides[heightIndex]
              + x * strides[widthIndex]
            let score = array[offset].doubleValue
            if score > bestScore {
              bestScore = score
              bestClass = channel
            }
          }
        } else {
          let offset = y * strides[heightIndex] + x * strides[widthIndex]
          bestClass = Int(array[offset].doubleValue.rounded())
        }
        labels[y * width + x] = WalkableSurfaceClass
          .fromModelClass(bestClass, channelCount: channelCount).rawValue
      }
    }

    return WalkableSurfaceMask(labels: labels, width: width, height: height, timestamp: timestamp)
  }
}
