import Foundation
import simd

/// Swift/ARKit adaptation of the semantic-grid route search in Mobilio's
/// `Vision.cs`. The advisor never authorizes motion by itself: its heading is
/// only a preference for `LocalRoutePlanner`, where fresh LiDAR free-space and
/// obstacle evidence remain mandatory.
final class MobilioRouteAdvisor {
  struct Recommendation {
    struct Branch {
      let direction: String
      let distanceM: Float
    }

    let headingDegrees: Float
    let pathLengthM: Float
    let branches: [Branch]
  }

  private struct Cell: Hashable {
    let x: Int
    let z: Int
  }

  private struct Surface {
    let laxWalkable: Bool
    let strictWalkable: Bool
    let updatedAt: TimeInterval
  }

  private struct Ray {
    let angle: Float
    let distance: Float
  }

  private let nodeSize: Float = 0.20
  private let fillRadius: Float = 15
  private let minPathLength: Float
  private let minBranchLength: Float = 3.5
  private let gridSkips = 2
  private let maxDisparity: Float = 30
  private let validDuration: TimeInterval = 1
  private let historyWeights: [Float] = [0.5, 0.25, 0.15, 0.10]

  private var grid: [Cell: Surface] = [:]
  private var headingHistory: [(angle: Float, timestamp: TimeInterval)] = []
  private var lastValidRecommendation: (value: Recommendation, timestamp: TimeInterval)?
  private var lastOrigin: SIMD3<Float>?
  private var lastForward: SIMD3<Float>?

  init(minimumPathLength: Float = 5) {
    minPathLength = minimumPathLength
  }

  func reset() {
    grid.removeAll(keepingCapacity: true)
    headingHistory.removeAll(keepingCapacity: true)
    lastValidRecommendation = nil
    lastOrigin = nil
    lastForward = nil
  }

  func observe(
    point: SIMD3<Float>,
    laxWalkable: Bool,
    strictWalkable: Bool,
    timestamp: TimeInterval
  ) {
    grid[cell(for: point)] = Surface(
      laxWalkable: laxWalkable,
      strictWalkable: strictWalkable,
      updatedAt: timestamp
    )
  }

  func recommendation(
    origin: SIMD3<Float>,
    forward: SIMD3<Float>,
    right: SIMD3<Float>,
    targetAngleDegrees: Float = 0,
    timestamp: TimeInterval
  ) -> Recommendation? {
    prune(timestamp: timestamp)
    // Relative headings cannot be reused after the phone turns or translates.
    if let lastOrigin, let lastForward,
       simd_distance(origin, lastOrigin) > 0.1 || simd_dot(forward, lastForward) < 0.999 {
      headingHistory.removeAll(keepingCapacity: true)
      lastValidRecommendation = nil
    }
    lastOrigin = origin
    lastForward = forward
    guard grid.count >= 80, grid.values.contains(where: { $0.strictWalkable }) else {
      return recentFallback(timestamp: timestamp)
    }

    var validRays: [Ray] = []
    for angleOffset in -90...90 {
      let angle = targetAngleDegrees + Float(angleOffset)
      let distance = raycast(
        origin: origin,
        direction: direction(angleDegrees: angle, forward: forward, right: right)
      )
      if distance > minPathLength {
        validRays.append(Ray(angle: angle, distance: distance))
      }
    }

    guard !validRays.isEmpty else { return recentFallback(timestamp: timestamp) }
    let branches = consolidate(rays: validRays)
    guard let best = branches.min(by: {
      angleDifference($0.angle, targetAngleDegrees) < angleDifference($1.angle, targetAngleDegrees)
    }), angleDifference(best.angle, targetAngleDegrees) <= maxDisparity else {
      return recentFallback(timestamp: timestamp)
    }

    headingHistory.insert((best.angle, timestamp), at: 0)
    headingHistory = Array(headingHistory.prefix(historyWeights.count))
    let smoothedHeading = weightedHeading()
    let detectedBranches = detectBranches(
      origin: origin,
      forward: forward,
      right: right,
      mainHeading: smoothedHeading,
      mainLength: best.distance
    )
    let result = Recommendation(
      headingDegrees: smoothedHeading,
      pathLengthM: best.distance,
      branches: detectedBranches
    )
    lastValidRecommendation = (result, timestamp)
    return result
  }

  private func consolidate(rays: [Ray]) -> [Ray] {
    guard var current = rays.first else { return [] }
    var result: [Ray] = []
    var previousAngle = current.angle

    for ray in rays.dropFirst() {
      if ray.angle - previousAngle > 1.01 {
        result.append(current)
        current = ray
      } else if ray.distance > current.distance ||
                  (abs(ray.distance - current.distance) < 0.001 && abs(ray.angle) < abs(current.angle)) {
        current = ray
      }
      previousAngle = ray.angle
    }
    result.append(current)
    return result
  }

  /// Detects openings on both sides of the accepted path. Mobilio applies the
  /// same test only in the expected navigation-turn direction; PathFinder has
  /// no destination bearing yet, so returning both sides avoids inventing one.
  private func detectBranches(
    origin: SIMD3<Float>,
    forward: SIMD3<Float>,
    right: SIMD3<Float>,
    mainHeading: Float,
    mainLength: Float
  ) -> [Recommendation.Branch] {
    var result: [Recommendation.Branch] = []
    let directions: [(String, Float)] = [("left", -90), ("right", 90)]
    for (name, turn) in directions {
      var distances: [Float] = []
      var branchLengths: [Float] = []
      var totalLengths: [Float] = []
      let mainDirection = direction(angleDegrees: mainHeading, forward: forward, right: right)

      for distance in stride(from: 2 as Float, to: mainLength, by: nodeSize / 2) {
        let start = origin + mainDirection * distance
        let branchDirection = direction(
          angleDegrees: mainHeading + turn,
          forward: forward,
          right: right
        )
        let branchLength = raycast(origin: start, direction: branchDirection)
        let oppositeLength = raycast(origin: start, direction: -branchDirection)
        distances.append(distance)
        branchLengths.append(branchLength)
        totalLengths.append(branchLength + oppositeLength)
      }

      guard branchLengths.count > 1 else { continue }
      let totalMedian = median(totalLengths)
      let branchMedian = median(branchLengths)
      let good = distances.indices.compactMap { index -> Float? in
        guard totalLengths[index] > totalMedian + minBranchLength,
              branchLengths[index] > branchMedian + minBranchLength else { return nil }
        return distances[index]
      }
      for distance in consolidateBranchDistances(good) {
        result.append(Recommendation.Branch(direction: name, distanceM: distance))
      }
    }
    return result.sorted { $0.distanceM < $1.distanceM }
  }

  private func consolidateBranchDistances(_ values: [Float]) -> [Float] {
    guard var previous = values.first else { return [] }
    var sum = previous
    var count: Float = 1
    var result: [Float] = []

    for value in values.dropFirst() {
      if value - previous > nodeSize {
        result.append(sum / count)
        sum = value
        count = 1
      } else {
        sum += value
        count += 1
      }
      previous = value
    }
    result.append(sum / count)
    return result
  }

  /// Grid DDA matching Mobilio's `RaycastGridWalkable`: two consecutive
  /// missing/non-walkable cells are tolerated, and a valid cell resets skips.
  private func raycast(origin: SIMD3<Float>, direction: SIMD3<Float>) -> Float {
    let horizontal = SIMD2<Float>(direction.x, direction.z)
    guard simd_length(horizontal) > 0.001 else { return 0 }
    let ray = simd_normalize(horizontal)
    var x = Int(round(origin.x / nodeSize))
    var z = Int(round(origin.z / nodeSize))
    let start = SIMD2<Float>(Float(x) * nodeSize, Float(z) * nodeSize)
    var lastValid = start
    var skips = 0

    let stepX = ray.x >= 0 ? 1 : -1
    let stepZ = ray.y >= 0 ? 1 : -1
    let nextBoundaryX = (Float(x) + (stepX > 0 ? 0.5 : -0.5)) * nodeSize
    let nextBoundaryZ = (Float(z) + (stepZ > 0 ? 0.5 : -0.5)) * nodeSize
    var tMaxX = ray.x == 0 ? Float.infinity : (nextBoundaryX - origin.x) / ray.x
    var tMaxZ = ray.y == 0 ? Float.infinity : (nextBoundaryZ - origin.z) / ray.y
    let tDeltaX = ray.x == 0 ? Float.infinity : abs(nodeSize / ray.x)
    let tDeltaZ = ray.y == 0 ? Float.infinity : abs(nodeSize / ray.y)

    while min(tMaxX, tMaxZ) <= fillRadius {
      if tMaxX < tMaxZ {
        tMaxX += tDeltaX
        x += stepX
      } else {
        tMaxZ += tDeltaZ
        z += stepZ
      }

      let key = Cell(x: x, z: z)
      if grid[key]?.laxWalkable == true {
        skips = 0
        lastValid = SIMD2<Float>(Float(x) * nodeSize, Float(z) * nodeSize)
      } else {
        skips += 1
        if skips > gridSkips { break }
      }
    }
    return simd_distance(start, lastValid)
  }

  private func direction(
    angleDegrees: Float,
    forward: SIMD3<Float>,
    right: SIMD3<Float>
  ) -> SIMD3<Float> {
    let radians = angleDegrees * .pi / 180
    return simd_normalize(forward * cos(radians) + right * sin(radians))
  }

  private func weightedHeading() -> Float {
    var weighted: Float = 0
    var totalWeight: Float = 0
    for (index, value) in headingHistory.enumerated() {
      let weight = historyWeights[index]
      weighted += value.angle * weight
      totalWeight += weight
    }
    return totalWeight > 0 ? weighted / totalWeight : 0
  }

  private func recentFallback(timestamp: TimeInterval) -> Recommendation? {
    guard let lastValidRecommendation,
          timestamp - lastValidRecommendation.timestamp <= validDuration else { return nil }
    return lastValidRecommendation.value
  }

  private func prune(timestamp: TimeInterval) {
    grid = grid.filter { timestamp - $0.value.updatedAt <= validDuration }
    headingHistory = headingHistory.filter { timestamp - $0.timestamp <= validDuration }
    if let lastValidRecommendation,
       timestamp - lastValidRecommendation.timestamp > validDuration {
      self.lastValidRecommendation = nil
    }
    if grid.count > 30_000 {
      for key in grid.sorted(by: { $0.value.updatedAt < $1.value.updatedAt })
        .prefix(grid.count - 30_000).map(\.key) {
        grid.removeValue(forKey: key)
      }
    }
  }

  private func median(_ values: [Float]) -> Float {
    guard !values.isEmpty else { return 0 }
    let sorted = values.sorted()
    return (sorted[sorted.count / 2] + sorted[(sorted.count - 1) / 2]) / 2
  }

  private func angleDifference(_ first: Float, _ second: Float) -> Float {
    let normalized = abs(first - second).truncatingRemainder(dividingBy: 360)
    return min(normalized, 360 - normalized)
  }

  private func cell(for point: SIMD3<Float>) -> Cell {
    Cell(x: Int(round(point.x / nodeSize)), z: Int(round(point.z / nodeSize)))
  }
}
