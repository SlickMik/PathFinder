import Foundation
import simd

/// A small, world-locked occupancy grid for local guidance. It intentionally
/// plans only a few metres ahead: that keeps stale evidence bounded and avoids
/// pretending the phone has mapped areas it has not actually observed.
final class LocalRoutePlanner {
  typealias Payload = [String: Any]

  private struct Cell: Hashable {
    let x: Int
    let z: Int
  }

  private struct Evidence {
    var score: Float
    var updatedAt: TimeInterval
    var person: Bool
  }

  private struct SurfaceEvidence {
    var score: Float
    var updatedAt: TimeInterval
    var className: String
  }

  private struct Node {
    let cell: Cell
    let priority: Float
  }

  private let cellSize: Float = 0.10
  private let mapLifetime: TimeInterval = 3.0
  private let surfaceLifetime: TimeInterval = 1.25
  private let planningRange: Float = 3.2
  private let requiredRadius: Float = 0.39 // body radius + a conservative side margin
  private let narrowOpeningWidth: Float = 1.15
  // Mobilio defaults to 5 m outdoors. Indoor camera views need a shorter
  // observed path; the LiDAR line search still verifies its own 2 m corridor.
  private let semanticAdvisor = MobilioRouteAdvisor(minimumPathLength: 1.2)
  private var evidence: [Cell: Evidence] = [:]
  private var surfaceEvidence: [Cell: SurfaceEvidence] = [:]
  private var lastSurfaceMaskTimestamp: TimeInterval = -.infinity

  func reset() {
    evidence.removeAll(keepingCapacity: true)
    surfaceEvidence.removeAll(keepingCapacity: true)
    lastSurfaceMaskTimestamp = -.infinity
    semanticAdvisor.reset()
  }

  func beginSurfaceObservation(maskTimestamp: TimeInterval) -> Bool {
    guard maskTimestamp > lastSurfaceMaskTimestamp else { return false }
    lastSurfaceMaskTimestamp = maskTimestamp
    return true
  }

  func observeSurface(
    at point: SIMD3<Float>,
    traversability: Float?,
    laxWalkable: Bool,
    strictWalkable: Bool,
    className: String,
    timestamp: TimeInterval,
    includeInLocalGrid: Bool = true
  ) {
    semanticAdvisor.observe(
      point: point,
      laxWalkable: laxWalkable,
      strictWalkable: strictWalkable,
      timestamp: timestamp
    )
    guard includeInLocalGrid, let traversability else { return }

    let key = cell(for: point)
    var value = surfaceEvidence[key] ?? SurfaceEvidence(
      score: 0,
      updatedAt: timestamp,
      className: className
    )
    if traversability < 0 {
      // A newly observed curb or road boundary wins immediately over older
      // positive labels. False-negative boundaries are safer than allowing an
      // old sidewalk prediction to leak into the next route.
      value.score = max(-2.5, min(-0.6, value.score + traversability))
    } else {
      value.score = min(2.5, max(-2.5, value.score + traversability * 0.72))
      value.className = className
    }
    value.updatedAt = timestamp
    surfaceEvidence[key] = value
  }

  func observeRay(
    from origin: SIMD3<Float>,
    to endpoint: SIMD3<Float>,
    isObstacle: Bool,
    isPerson: Bool,
    timestamp: TimeInterval
  ) {
    let start = cell(for: origin)
    let end = cell(for: endpoint)
    let dx = end.x - start.x
    let dz = end.z - start.z
    let steps = max(abs(dx), abs(dz))
    guard steps > 0 else { return }

    // Stop before the return so a wall is not accidentally carved back to free.
    let freeSteps = isObstacle ? max(0, steps - 1) : steps
    if freeSteps > 0 {
      for index in 1...freeSteps {
        let amount = Float(index) / Float(steps)
        let key = Cell(
          x: start.x + Int((Float(dx) * amount).rounded()),
          z: start.z + Int((Float(dz) * amount).rounded())
        )
        update(key, delta: -0.42, person: false, timestamp: timestamp)
      }
    }
    if isObstacle {
      update(end, delta: isPerson ? 2.4 : 1.25, person: isPerson, timestamp: timestamp)
    }
  }

  func guidance(
    cameraPosition: SIMD3<Float>,
    forward: SIMD3<Float>,
    right: SIMD3<Float>,
    timestamp: TimeInterval
  ) -> Payload {
    prune(timestamp: timestamp)
    let start = cell(for: cameraPosition)
    let semanticRecommendation = semanticAdvisor.recommendation(
      origin: cameraPosition,
      forward: forward,
      right: right,
      timestamp: timestamp
    )
    let radiusCells = Int(ceil(requiredRadius / cellSize))
    let obstacles = Set(evidence.compactMap { key, value in value.score >= 0.8 ? key : nil })
    let lidarFree = Set(evidence.compactMap { key, value in value.score <= -0.35 ? key : nil })
    guard lidarFree.count >= 35 else { return unknown(status: "unknown") }

    let walkableSurface = Set(surfaceEvidence.compactMap { key, value in
      value.score >= 0.35 ? key : nil
    })
    let surfaceBoundaries = Set(surfaceEvidence.compactMap { key, value in
      value.score <= -0.5 ? key : nil
    })
    var fusedFree = lidarFree.intersection(walkableSurface)
    // The camera cannot see the ground directly below the phone. Keep a short
    // LiDAR-confirmed bridge from the start into the segmented surface.
    fusedFree.formUnion(lidarFree.filter { distance($0, start) * cellSize <= 0.55 })
    let usesSegmentation = walkableSurface.count >= 55 && fusedFree.count >= 35
    let knownFree = usesSegmentation ? fusedFree : lidarFree

    let semanticBoundaries = surfaceBoundaries
    let rawBlocked = obstacles.union(semanticBoundaries)
    let blocked = inflated(obstacles: rawBlocked, radius: radiusCells)
    let obstaclePoints = rawBlocked
      .sorted { distance($0, start) < distance($1, start) }
      .prefix(80)
      .map { cell -> Payload in
        let point = worldCenter(cell, y: cameraPosition.y)
        let delta = point - cameraPosition
        return [
          "lateralM": Double(simd_dot(delta, right)),
          "forwardM": Double(simd_dot(delta, forward))
        ]
      }
    let candidates = goalCandidates(
      cameraPosition: cameraPosition,
      forward: forward,
      right: right,
      knownFree: knownFree,
      blocked: blocked,
      preferredHeadingDegrees: semanticRecommendation?.headingDegrees
    )

    // DepthImage.cs: BestLineDirection / AttemptLine. Try the desired heading,
    // then alternating +2, -2 ... +90, -90 degree corrections. Unlike the
    // source's initially-open grid, every traversed cell must be observed free.
    let directPath = mobilioLinePath(
      origin: cameraPosition, forward: forward, right: right,
      preferredHeading: semanticRecommendation?.headingDegrees ?? 0,
      knownFree: knownFree, blocked: blocked
    )
    var bestPath: [Cell]? = directPath
    var bestGoal: Cell? = directPath?.last
    for goal in candidates where bestPath == nil {
      if let path = findPath(from: start, to: goal, knownFree: knownFree, blocked: blocked) {
        bestPath = path
        bestGoal = goal
        // Candidates are already ranked by forward progress, semantic heading,
        // and steering magnitude. Use the first one that A* can safely reach.
        break
      }
    }

    guard let path = bestPath, let goal = bestGoal, path.count >= 2 else {
      return [
        "instruction": "stop",
        "status": "blocked",
        "minimumClearanceM": NSNull(),
        "openingWidthM": NSNull(),
        "headingDeltaDeg": 0,
        "confidence": min(1, Double(knownFree.count) / 350),
        "isNarrowOpening": false,
        "source": usesSegmentation ? "segmented-path" : "lidar-route",
        "semanticHeadingDeg": bridgeNumber(semanticRecommendation?.headingDegrees),
        "semanticPathLengthM": bridgeNumber(semanticRecommendation?.pathLengthM),
        "branches": branchPayload(semanticRecommendation),
        "path": [],
        "obstacles": obstaclePoints
      ]
    }

    let sampledPath = Array(path.prefix(min(path.count, 24)))
    let minimumClearance = sampledPath
      .map { clearance(from: $0, obstacles: obstacles) }
      .min() ?? requiredRadius
    let openingWidth = minimumClearance * 2
    let isNarrow = openingWidth < narrowOpeningWidth && openingWidth >= requiredRadius * 2

    let lookahead = path[min(path.count - 1, 6)]
    let lookaheadWorld = worldCenter(lookahead, y: cameraPosition.y)
    let direction = lookaheadWorld - cameraPosition
    let forwardAmount = simd_dot(direction, forward)
    let rightAmount = simd_dot(direction, right)
    let heading = atan2(rightAmount, max(0.01, forwardAmount)) * 180 / .pi
    let instruction = instruction(for: heading, narrow: isNarrow)
    let lidarConfidence = min(1, Double(path.filter { lidarFree.contains($0) }.count) / Double(path.count))
    let semanticConfidence = usesSegmentation
      ? min(1, Double(path.filter { walkableSurface.contains($0) }.count) / Double(path.count))
      : 1
    let confidence = usesSegmentation
      ? min(lidarConfidence, semanticConfidence)
      : lidarConfidence
    let surfaceClass = dominantSurfaceClass(along: path)
    let routePoints = sampledPath.map { cell -> Payload in
      let point = worldCenter(cell, y: cameraPosition.y)
      let delta = point - cameraPosition
      return [
        "lateralM": Double(simd_dot(delta, right)),
        "forwardM": Double(simd_dot(delta, forward))
      ]
    }

    return [
      "instruction": instruction,
      "status": isNarrow ? "narrow" : "clear",
      "minimumClearanceM": Double(minimumClearance),
      "openingWidthM": Double(openingWidth),
      "headingDeltaDeg": Double(heading),
      "confidence": confidence,
      "isNarrowOpening": isNarrow,
      "source": usesSegmentation ? "segmented-path" : "lidar-route",
      "surfaceClass": surfaceClass ?? NSNull(),
      "goalDistanceM": Double(distance(start, goal) * cellSize),
      "semanticHeadingDeg": bridgeNumber(semanticRecommendation?.headingDegrees),
      "semanticPathLengthM": bridgeNumber(semanticRecommendation?.pathLengthM),
      "branches": branchPayload(semanticRecommendation),
      "path": routePoints,
      "obstacles": obstaclePoints
    ]
  }

  func unknown(status: String = "unknown") -> Payload {
    [
      "instruction": "hold",
      "status": status,
      "minimumClearanceM": NSNull(),
      "openingWidthM": NSNull(),
      "headingDeltaDeg": 0,
      "confidence": 0,
      "isNarrowOpening": false,
      "source": "lidar-route",
      "surfaceClass": NSNull(),
      "semanticHeadingDeg": NSNull(),
      "semanticPathLengthM": NSNull(),
      "branches": [],
      "path": [],
      "obstacles": []
    ]
  }

  private func update(_ cell: Cell, delta: Float, person: Bool, timestamp: TimeInterval) {
    var value = evidence[cell] ?? Evidence(score: 0, updatedAt: timestamp, person: false)
    // A new obstacle return overrides accumulated free space immediately.
    value.score = delta > 0
      ? min(3, max(delta, value.score + delta))
      : min(3, max(-2.5, value.score + delta))
    value.updatedAt = timestamp
    value.person = person || value.person
    evidence[cell] = value
  }

  private func prune(timestamp: TimeInterval) {
    evidence = evidence.filter { timestamp - $0.value.updatedAt <= ($0.value.person ? 0.8 : mapLifetime) }
    surfaceEvidence = surfaceEvidence.filter {
      timestamp - $0.value.updatedAt <= surfaceLifetime
    }
    if evidence.count > 18_000 {
      for key in evidence.sorted(by: { $0.value.updatedAt < $1.value.updatedAt })
        .prefix(evidence.count - 18_000).map(\.key) {
        evidence.removeValue(forKey: key)
      }
    }
    if surfaceEvidence.count > 8_000 {
      for key in surfaceEvidence.sorted(by: { $0.value.updatedAt < $1.value.updatedAt })
        .prefix(surfaceEvidence.count - 8_000).map(\.key) {
        surfaceEvidence.removeValue(forKey: key)
      }
    }
  }

  private func dominantSurfaceClass(along path: [Cell]) -> String? {
    var counts: [String: Int] = [:]
    for cell in path {
      guard let surface = surfaceEvidence[cell], surface.score > 0 else { continue }
      counts[surface.className, default: 0] += 1
    }
    return counts.max(by: { $0.value < $1.value })?.key
  }

  private func goalCandidates(
    cameraPosition: SIMD3<Float>,
    forward: SIMD3<Float>,
    right: SIMD3<Float>,
    knownFree: Set<Cell>,
    blocked: Set<Cell>,
    preferredHeadingDegrees: Float?
  ) -> [Cell] {
    var result: [(Cell, Float)] = []
    for longitudinal in stride(from: planningRange, through: 1.2, by: -0.4) {
      for lateral in stride(from: -1.0 as Float, through: 1.0, by: 0.2) {
        let position = cameraPosition + forward * longitudinal + right * lateral
        let key = cell(for: position)
        guard knownFree.contains(key), !blocked.contains(key) else { continue }
        let candidateHeading = atan2(lateral, longitudinal) * 180 / .pi
        let semanticPenalty = preferredHeadingDegrees.map {
          abs(candidateHeading - $0) * 0.08
        } ?? 0
        // Prefer forward progress, then Mobilio's semantic heading, then small
        // steering corrections. A* and LiDAR still decide whether it is safe.
        result.append((key, longitudinal * 4 - semanticPenalty - abs(lateral)))
      }
      if !result.isEmpty { break }
    }
    return result.sorted { $0.1 > $1.1 }.prefix(10).map(\.0)
  }

  private func findPath(
    from start: Cell,
    to goal: Cell,
    knownFree: Set<Cell>,
    blocked: Set<Cell>
  ) -> [Cell]? {
    let neighbours = [
      (-1, -1), (0, -1), (1, -1),
      (-1, 0),            (1, 0),
      (-1, 1),  (0, 1),  (1, 1)
    ]
    var frontier = [Node(cell: start, priority: 0)]
    var cameFrom: [Cell: Cell] = [:]
    var cost: [Cell: Float] = [start: 0]
    var iterations = 0

    while !frontier.isEmpty && iterations < 8_000 {
      iterations += 1
      frontier.sort { $0.priority > $1.priority }
      let current = frontier.removeLast().cell
      if current == goal { return reconstruct(cameFrom: cameFrom, current: current) }

      for (dx, dz) in neighbours {
        let next = Cell(x: current.x + dx, z: current.z + dz)
        guard !blocked.contains(next), knownFree.contains(next) || next == start else { continue }
        if dx != 0 && dz != 0 {
          let sideX = Cell(x: current.x + dx, z: current.z)
          let sideZ = Cell(x: current.x, z: current.z + dz)
          guard !blocked.contains(sideX), !blocked.contains(sideZ),
                knownFree.contains(sideX), knownFree.contains(sideZ) else { continue }
        }
        let diagonal: Float = dx != 0 && dz != 0 ? 1.414 : 1
        let nextCost = (cost[current] ?? .greatestFiniteMagnitude) + diagonal
        if nextCost < (cost[next] ?? .greatestFiniteMagnitude) {
          cost[next] = nextCost
          cameFrom[next] = current
          let heuristic = distance(next, goal)
          frontier.append(Node(cell: next, priority: nextCost + heuristic))
        }
      }
    }
    return nil
  }

  private func reconstruct(cameFrom: [Cell: Cell], current: Cell) -> [Cell] {
    var path = [current]
    var cursor = current
    while let previous = cameFrom[cursor] {
      path.append(previous)
      cursor = previous
    }
    return path.reversed()
  }

  private func mobilioLinePath(
    origin: SIMD3<Float>, forward: SIMD3<Float>, right: SIMD3<Float>,
    preferredHeading: Float, knownFree: Set<Cell>, blocked: Set<Cell>
  ) -> [Cell]? {
    let start = cell(for: origin)
    let offsets: [Float] = [0] + stride(from: 2, through: 90, by: 2).flatMap {
      [Float($0), -Float($0)]
    }
    for offset in offsets {
      let angle = preferredHeading + offset
      guard abs(angle) <= 90 else { continue }
      let radians = angle * .pi / 180
      let direction = forward * cos(radians) + right * sin(radians)
      var path = [start]
      var clear = !blocked.contains(start)
      for distance in stride(from: cellSize / 2, through: 2 as Float, by: cellSize / 2) {
        let next = cell(for: origin + direction * distance)
        guard next != path.last else { continue }
        if blocked.contains(next) || !knownFree.contains(next) {
          clear = false
          break
        }
        let previous = path.last!
        if next.x != previous.x && next.z != previous.z {
          let sides = [Cell(x: next.x, z: previous.z), Cell(x: previous.x, z: next.z)]
          if sides.contains(where: { blocked.contains($0) || !knownFree.contains($0) }) {
            clear = false
            break
          }
        }
        path.append(next)
      }
      if clear && path.count > 1 { return path }
    }
    return nil
  }

  private func inflated(obstacles: Set<Cell>, radius: Int) -> Set<Cell> {
    var result = obstacles
    for obstacle in obstacles {
      for x in -radius...radius {
        for z in -radius...radius where x * x + z * z <= radius * radius {
          result.insert(Cell(x: obstacle.x + x, z: obstacle.z + z))
        }
      }
    }
    return result
  }

  private func clearance(from cell: Cell, obstacles: Set<Cell>) -> Float {
    guard !obstacles.isEmpty else { return planningRange }
    let nearest = obstacles.reduce(Float.greatestFiniteMagnitude) {
      min($0, distance(cell, $1) * cellSize)
    }
    return min(nearest, planningRange)
  }

  private func instruction(for degrees: Float, narrow: Bool) -> String {
    if narrow && abs(degrees) < 12 { return "straight" }
    if degrees < -28 { return "left" }
    if degrees < -8 { return "slight-left" }
    if degrees > 28 { return "right" }
    if degrees > 8 { return "slight-right" }
    return "straight"
  }

  private func branchPayload(_ recommendation: MobilioRouteAdvisor.Recommendation?) -> [Payload] {
    recommendation?.branches.map {
      ["direction": $0.direction, "distanceM": Double($0.distanceM)]
    } ?? []
  }

  private func bridgeNumber(_ value: Float?) -> Any {
    guard let value else { return NSNull() }
    return Double(value)
  }

  private func cell(for point: SIMD3<Float>) -> Cell {
    Cell(x: Int(floor(point.x / cellSize)), z: Int(floor(point.z / cellSize)))
  }

  private func worldCenter(_ cell: Cell, y: Float) -> SIMD3<Float> {
    SIMD3<Float>((Float(cell.x) + 0.5) * cellSize, y, (Float(cell.z) + 0.5) * cellSize)
  }

  private func distance(_ a: Cell, _ b: Cell) -> Float {
    hypot(Float(a.x - b.x), Float(a.z - b.z))
  }
}
