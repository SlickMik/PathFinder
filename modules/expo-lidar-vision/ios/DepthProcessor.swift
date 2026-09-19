import ARKit
import CoreVideo
import simd

final class DepthProcessor {
  typealias Payload = [String: Any]

  private struct VoxelKey: Hashable {
    let x: Int
    let y: Int
    let z: Int
  }

  private struct MapPoint {
    let position: SIMD3<Float>
    let confidence: Int
    let updatedAt: TimeInterval
  }

  private struct DistanceSample {
    let timestamp: TimeInterval
    let distance: Float
  }

  private var obstacleMap: [VoxelKey: MapPoint] = [:]
  private var corridorHistory: [DistanceSample] = []
  private let routePlanner = LocalRoutePlanner()
  private let personSegmenter = PersonSegmenter()
  private let voxelSize: Float = 0.1
  private let mapLifetime: TimeInterval = 0.45
  private let sampleStride = 3

  func reset() {
    obstacleMap.removeAll(keepingCapacity: true)
    corridorHistory.removeAll(keepingCapacity: true)
    routePlanner.reset()
    personSegmenter.reset()
  }

  func unknownSnapshot(tracking: String, aim: String, speedMps: Float = 0) -> Payload {
    let unknown = sectorReading(distance: nil, confidence: "low", coverage: 0)
    corridorHistory.removeAll(keepingCapacity: true)
    return [
      "timestampMs": Date().timeIntervalSince1970 * 1000,
      "tracking": tracking,
      "deviceAim": aim,
      "motion": ["speedMps": Double(speedMps)],
      "left": unknown,
      "center": unknown,
      "right": unknown,
      "corridor": [
        "distanceM": NSNull(),
        "timeToContactS": NSNull(),
        "coverage": 0,
        "risk": "unknown"
      ],
      "route": routePlanner.unknown()
    ]
  }

  func process(
    frame: ARFrame,
    depthData: ARDepthData,
    floorHeight: Float?,
    options: LidarSessionOptions,
    tracking: String,
    aim: String,
    speedMps: Float
  ) -> Payload {
    guard let confidenceMap = depthData.confidenceMap else {
      return unknownSnapshot(tracking: tracking, aim: aim, speedMps: speedMps)
    }

    let depthMap = depthData.depthMap
    let width = CVPixelBufferGetWidth(depthMap)
    let height = CVPixelBufferGetHeight(depthMap)
    guard width > 0, height > 0,
          width == CVPixelBufferGetWidth(confidenceMap),
          height == CVPixelBufferGetHeight(confidenceMap) else {
      return unknownSnapshot(tracking: tracking, aim: aim, speedMps: speedMps)
    }
    let personMask = personSegmenter.mask(for: frame)

    CVPixelBufferLockBaseAddress(depthMap, .readOnly)
    CVPixelBufferLockBaseAddress(confidenceMap, .readOnly)
    defer {
      CVPixelBufferUnlockBaseAddress(confidenceMap, .readOnly)
      CVPixelBufferUnlockBaseAddress(depthMap, .readOnly)
    }

    guard let depthBase = CVPixelBufferGetBaseAddress(depthMap),
          let confidenceBase = CVPixelBufferGetBaseAddress(confidenceMap) else {
      return unknownSnapshot(tracking: tracking, aim: aim, speedMps: speedMps)
    }

    let transform = frame.camera.transform
    let cameraPosition = SIMD3<Float>(
      transform.columns.3.x,
      transform.columns.3.y,
      transform.columns.3.z
    )
    let rawForward = SIMD3<Float>(-transform.columns.2.x, 0, -transform.columns.2.z)
    guard simd_length(rawForward) > 0.001 else {
      return unknownSnapshot(tracking: tracking, aim: "unstable", speedMps: speedMps)
    }
    let forward = simd_normalize(rawForward)
    let right = simd_normalize(simd_cross(forward, SIMD3<Float>(0, 1, 0)))

    let intrinsics = frame.camera.intrinsics
    let imageResolution = frame.camera.imageResolution
    let widthScale = Float(width) / Float(imageResolution.width)
    let heightScale = Float(height) / Float(imageResolution.height)
    let fx = intrinsics.columns.0.x * widthScale
    let fy = intrinsics.columns.1.y * heightScale
    let cx = intrinsics.columns.2.x * widthScale
    let cy = intrinsics.columns.2.y * heightScale
    guard fx > 0, fy > 0 else {
      return unknownSnapshot(tracking: tracking, aim: "unstable", speedMps: speedMps)
    }

    let depthRowBytes = CVPixelBufferGetBytesPerRow(depthMap)
    let confidenceRowBytes = CVPixelBufferGetBytesPerRow(confidenceMap)
    let now = frame.timestamp
    var examined = 0
    var sectorReliableCounts = [0, 0, 0]
    var sectorConfidenceValues = [[Int](), [Int](), [Int]()]
    var corridorReliableCount = 0

    for pixelY in stride(from: 0, to: height, by: sampleStride) {
      let depthRow = depthBase.advanced(by: pixelY * depthRowBytes)
        .assumingMemoryBound(to: Float32.self)
      let confidenceRow = confidenceBase.advanced(by: pixelY * confidenceRowBytes)
        .assumingMemoryBound(to: UInt8.self)

      for pixelX in stride(from: 0, to: width, by: sampleStride) {
        examined += 1
        let depth = depthRow[pixelX]
        let confidence = Int(confidenceRow[pixelX])
        guard depth.isFinite,
              depth >= 0.15,
              depth <= Float(options.maximumDistanceM),
              confidence >= options.minimumConfidence else { continue }

        let cameraPoint = SIMD4<Float>(
          (Float(pixelX) - cx) * depth / fx,
          -(Float(pixelY) - cy) * depth / fy,
          -depth,
          1
        )
        let worldPoint4 = transform * cameraPoint
        let worldPoint = SIMD3<Float>(worldPoint4.x, worldPoint4.y, worldPoint4.z)
        let delta = worldPoint - cameraPosition
        let forwardDistance = simd_dot(delta, forward)
        let lateralDistance = simd_dot(delta, right)
        guard forwardDistance >= 0.12, forwardDistance <= Float(options.maximumDistanceM) else {
          continue
        }

        if let sectorIndex = sectorIndex(lateral: lateralDistance, forward: forwardDistance) {
          sectorReliableCounts[sectorIndex] += 1
          sectorConfidenceValues[sectorIndex].append(confidence)
        }
        if abs(lateralDistance) <= Float(options.corridorWidthM / 2) {
          corridorReliableCount += 1
        }

        let relativeHeight = worldPoint.y - cameraPosition.y
        let onDetectedFloor = floorHeight.map { abs(worldPoint.y - $0) < 0.08 } ?? false
        let isPerson = personMask?.contains(
          depthX: pixelX,
          depthY: pixelY,
          depthWidth: width,
          depthHeight: height
        ) ?? false
        let isRouteObstacle = isPerson || (!onDetectedFloor && relativeHeight > -1.30)
        if ((pixelX / sampleStride) + (pixelY / sampleStride)).isMultiple(of: 2) {
          routePlanner.observeRay(
            from: cameraPosition,
            to: worldPoint,
            isObstacle: isRouteObstacle,
            isPerson: isPerson,
            timestamp: now
          )
        }
        guard relativeHeight >= -1.65, relativeHeight <= 1.0, !onDetectedFloor else { continue }

        let key = VoxelKey(
          x: Int(floor(worldPoint.x / voxelSize)),
          y: Int(floor(worldPoint.y / voxelSize)),
          z: Int(floor(worldPoint.z / voxelSize))
        )
        obstacleMap[key] = MapPoint(position: worldPoint, confidence: confidence, updatedAt: now)
      }
    }

    obstacleMap = obstacleMap.filter { now - $0.value.updatedAt <= mapLifetime }
    if obstacleMap.count > 12_000 {
      let oldestKeys = obstacleMap
        .sorted { $0.value.updatedAt < $1.value.updatedAt }
        .prefix(obstacleMap.count - 12_000)
        .map(\.key)
      for key in oldestKeys { obstacleMap.removeValue(forKey: key) }
    }

    var sectorDistances = [[Float](), [Float](), [Float]()]
    var sectorMapConfidence = [[Int](), [Int](), [Int]()]
    var corridorDistances: [Float] = []

    for point in obstacleMap.values {
      let delta = point.position - cameraPosition
      let forwardDistance = simd_dot(delta, forward)
      let lateralDistance = simd_dot(delta, right)
      let relativeHeight = point.position.y - cameraPosition.y
      guard forwardDistance >= 0.12,
            forwardDistance <= Float(options.maximumDistanceM),
            relativeHeight >= -1.65,
            relativeHeight <= 1.0 else { continue }

      let distance = simd_length(delta)
      if let index = sectorIndex(lateral: lateralDistance, forward: forwardDistance) {
        sectorDistances[index].append(distance)
        sectorMapConfidence[index].append(point.confidence)
      }
      if abs(lateralDistance) <= Float(options.corridorWidthM / 2) {
        corridorDistances.append(distance)
      }
    }

    let estimatedPerSector = max(Double(examined) / 3.0, 1)
    let leftCoverage = min(Double(sectorReliableCounts[0]) / estimatedPerSector, 1)
    let centerCoverage = min(Double(sectorReliableCounts[1]) / estimatedPerSector, 1)
    let rightCoverage = min(Double(sectorReliableCounts[2]) / estimatedPerSector, 1)
    let estimatedCorridorSamples = max(Double(examined) * 0.22, 1)
    let corridorCoverage = min(Double(corridorReliableCount) / estimatedCorridorSamples, 1)

    let leftDistance = percentile15(sectorDistances[0])
    let centerDistance = percentile15(sectorDistances[1])
    let rightDistance = percentile15(sectorDistances[2])
    let corridorDistance = percentile15(corridorDistances)
    let timeToContact = estimateTimeToContact(distance: corridorDistance, timestamp: now)
    let corridorRisk = risk(
      distance: corridorDistance,
      timeToContact: timeToContact,
      coverage: corridorCoverage,
      reactionTime: options.reactionTimeS,
      speedMps: speedMps,
      maximumDistanceM: Float(options.maximumDistanceM)
    )
    let route = routePlanner.guidance(
      cameraPosition: cameraPosition,
      forward: forward,
      right: right,
      timestamp: now
    )

    return [
      "timestampMs": Date().timeIntervalSince1970 * 1000,
      "tracking": tracking,
      "deviceAim": aim,
      "motion": ["speedMps": Double(speedMps)],
      "left": sectorReading(
        distance: leftDistance,
        confidence: confidenceLabel(sectorConfidenceValues[0] + sectorMapConfidence[0]),
        coverage: leftCoverage
      ),
      "center": sectorReading(
        distance: centerDistance,
        confidence: confidenceLabel(sectorConfidenceValues[1] + sectorMapConfidence[1]),
        coverage: centerCoverage
      ),
      "right": sectorReading(
        distance: rightDistance,
        confidence: confidenceLabel(sectorConfidenceValues[2] + sectorMapConfidence[2]),
        coverage: rightCoverage
      ),
      "corridor": [
        "distanceM": bridgeNumber(corridorDistance),
        "timeToContactS": bridgeNumber(timeToContact),
        "coverage": corridorCoverage,
        "risk": corridorRisk
      ],
      "route": route
    ]
  }

  private func sectorIndex(lateral: Float, forward: Float) -> Int? {
    let angle = atan2(lateral, forward)
    guard abs(angle) <= 0.82 else { return nil }
    if angle < -0.20 { return 0 }
    if angle > 0.20 { return 2 }
    return 1
  }

  private func percentile15(_ values: [Float]) -> Float? {
    guard !values.isEmpty else { return nil }
    let sorted = values.sorted()
    let index = Int(floor(Double(sorted.count - 1) * 0.15))
    return sorted[index]
  }

  private func confidenceLabel(_ values: [Int]) -> String {
    guard !values.isEmpty else { return "low" }
    let average = Double(values.reduce(0, +)) / Double(values.count)
    if average >= 1.85 { return "high" }
    if average >= 1.0 { return "medium" }
    return "low"
  }

  private func sectorReading(
    distance: Float?,
    confidence: String,
    coverage: Double
  ) -> Payload {
    [
      "distanceM": bridgeNumber(distance),
      "confidence": confidence,
      "coverage": coverage
    ]
  }

  private func bridgeNumber(_ value: Float?) -> Any {
    value.map { Double($0) } ?? NSNull()
  }

  private func estimateTimeToContact(distance: Float?, timestamp: TimeInterval) -> Float? {
    guard let distance else {
      corridorHistory.removeAll(keepingCapacity: true)
      return nil
    }

    corridorHistory.append(DistanceSample(timestamp: timestamp, distance: distance))
    corridorHistory = corridorHistory.filter { timestamp - $0.timestamp <= 0.9 }
    guard corridorHistory.count >= 4 else { return nil }

    var closingSpeeds: [Float] = []
    for index in 1..<corridorHistory.count {
      let older = corridorHistory[index - 1]
      let newer = corridorHistory[index]
      let deltaTime = Float(newer.timestamp - older.timestamp)
      guard deltaTime > 0 else { continue }
      closingSpeeds.append((older.distance - newer.distance) / deltaTime)
    }

    guard let medianSpeed = median(closingSpeeds), medianSpeed > 0.15 else { return nil }
    let deviations = closingSpeeds.map { abs($0 - medianSpeed) }
    guard (median(deviations) ?? 1) < 0.45 else { return nil }
    let estimate = distance / medianSpeed
    return estimate > 0 && estimate <= 8 ? estimate : nil
  }

  private func median(_ values: [Float]) -> Float? {
    guard !values.isEmpty else { return nil }
    let sorted = values.sorted()
    let middle = sorted.count / 2
    if sorted.count.isMultiple(of: 2) {
      return (sorted[middle - 1] + sorted[middle]) / 2
    }
    return sorted[middle]
  }

  private func risk(
    distance: Float?,
    timeToContact: Float?,
    coverage: Double,
    reactionTime: Double,
    speedMps: Float,
    maximumDistanceM: Float
  ) -> String {
    guard coverage >= 0.22 else { return "unknown" }
    guard let distance else { return "clear" }

    let speed = min(max(speedMps, 0), 2.5)
    let reactionDistance = speed * Float(reactionTime)
    let brakingDistance = speed * speed / (2 * 1.4)
    let warningDistance = min(
      max(0.6 + reactionDistance + brakingDistance, 2.0),
      maximumDistanceM
    )
    let criticalDistance = min(0.6 + speed * 0.2, warningDistance - 0.75)
    let nearDistance = min(
      max(1.2 + speed * 0.45, criticalDistance + 0.35),
      warningDistance - 0.35
    )

    if distance < criticalDistance { return "critical" }
    if let timeToContact,
       timeToContact <= max(0.65, Float(reactionTime) * 0.5) { return "critical" }
    if distance < nearDistance { return "near" }
    if let timeToContact,
       timeToContact <= Float(reactionTime) { return "near" }
    if distance <= warningDistance { return "caution" }
    if let timeToContact,
       timeToContact <= Float(reactionTime) + 1 { return "caution" }
    return "clear"
  }
}
