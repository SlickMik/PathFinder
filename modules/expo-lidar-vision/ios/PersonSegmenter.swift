import ARKit
import CoreVideo
import Vision

struct PersonMask {
  let pixels: [UInt8]
  let width: Int
  let height: Int

  var containsPerson: Bool {
    pixels.contains { $0 >= 96 }
  }

  func contains(depthX: Int, depthY: Int, depthWidth: Int, depthHeight: Int) -> Bool {
    guard depthWidth > 0, depthHeight > 0, width > 0, height > 0 else { return false }
    let x = min(width - 1, max(0, depthX * width / depthWidth))
    let y = min(height - 1, max(0, depthY * height / depthHeight))
    return pixels[y * width + x] >= 96
  }
}

/// Runs Apple's on-device person segmentation model at a deliberately low rate.
/// Depth remains the source of distance; Vision only supplies semantic evidence
/// that a depth return belongs to a person and should be treated conservatively.
final class PersonSegmenter {
  private var lastMask: PersonMask?
  private var lastRun: TimeInterval = -.infinity
  private let minimumInterval: TimeInterval = 0.32

  func reset() {
    lastMask = nil
    lastRun = -.infinity
  }

  func currentMask() -> PersonMask? {
    lastMask
  }

  func mask(for frame: ARFrame) -> PersonMask? {
    guard frame.timestamp - lastRun >= minimumInterval else { return lastMask }
    lastRun = frame.timestamp

    let request = VNGeneratePersonSegmentationRequest()
    request.qualityLevel = .balanced
    request.outputPixelFormat = kCVPixelFormatType_OneComponent8

    do {
      try VNImageRequestHandler(cvPixelBuffer: frame.capturedImage, orientation: .up).perform([request])
      guard let buffer = request.results?.first?.pixelBuffer,
            let copied = copyMask(buffer) else { return lastMask }
      lastMask = copied
    } catch {
      // A missed CV frame must never stop the higher-priority LiDAR safety stream.
    }
    return lastMask
  }

  private func copyMask(_ buffer: CVPixelBuffer) -> PersonMask? {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
    var pixels = [UInt8](repeating: 0, count: width * height)
    for y in 0..<height {
      let source = base.advanced(by: y * rowBytes).assumingMemoryBound(to: UInt8.self)
      pixels.withUnsafeMutableBufferPointer { destination in
        destination.baseAddress!.advanced(by: y * width).update(from: source, count: width)
      }
    }
    return PersonMask(pixels: pixels, width: width, height: height)
  }
}
