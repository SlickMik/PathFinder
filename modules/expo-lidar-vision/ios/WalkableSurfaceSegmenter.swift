import ARKit
import CoreML
import CoreVideo
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
    }
  }

  /// Positive values are walkable evidence and negative values are boundaries.
  /// Background stays unknown, and road is deliberately not considered walkable
  /// unless a future navigation state explicitly authorizes a road crossing.
  var traversability: Float? {
    switch self {
    case .sidewalk, .curbCut, .plainCrosswalk, .zebraCrosswalk, .covering:
      return 1
    case .terrain:
      return 0.45
    case .road, .curb:
      return -1
    case .background:
      return nil
    }
  }

  static func fromModelClass(_ rawValue: Int, channelCount: Int) -> WalkableSurfaceClass {
    // The bundled Tiramisu45 baseline is a 12-channel Cityscapes/CamVid
    // model. It has reliable road (6) and sidewalk (7) channels, but not the
    // nine Mobilio labels, so all other classes stay conservative/unknown.
    if channelCount == 12 {
      switch rawValue {
      case 6: return .road
      case 7: return .sidewalk
      default: return .background
      }
    }
    return WalkableSurfaceClass(rawValue: UInt8(clamping: rawValue)) ?? .background
  }
}

struct WalkableSurfaceMask {
  let labels: [UInt8]
  let width: Int
  let height: Int
  let timestamp: TimeInterval

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
  private var lastMask: WalkableSurfaceMask?
  private var lastRun: TimeInterval = -.infinity
  private let minimumInterval: TimeInterval = 0.18
  private let model: VNCoreMLModel?

  init() {
    model = Self.loadModel()
  }

  func reset() {
    lastMask = nil
    lastRun = -.infinity
  }

  func mask(for frame: ARFrame) -> WalkableSurfaceMask? {
    guard let model else { return nil }
    guard frame.timestamp - lastRun >= minimumInterval else { return lastMask }
    lastRun = frame.timestamp

    let request = VNCoreMLRequest(model: model)
    request.imageCropAndScaleOption = .scaleFill

    do {
      // ARKit's captured buffer and scene-depth buffer use the same native
      // landscape camera coordinate space, so keep both unrotated here.
      try VNImageRequestHandler(
        cvPixelBuffer: frame.capturedImage,
        orientation: .up
      ).perform([request])
      guard let mask = Self.mask(from: request.results, timestamp: frame.timestamp) else {
        return lastMask
      }
      lastMask = mask
    } catch {
      // Semantic inference must never interrupt the higher-priority LiDAR loop.
    }
    return lastMask
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
          for channel in 0..<min(channelCount, 9) {
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
