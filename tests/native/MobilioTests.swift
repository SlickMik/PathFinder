import Foundation
import simd

@main
enum MobilioTests {
  static let origin = SIMD3<Float>(0, 0, 0)
  static let forward = SIMD3<Float>(0, 0, 1)
  static let right = SIMD3<Float>(1, 0, 0)

  static func main() {
    let advisor = MobilioRouteAdvisor()
    for x in -5...5 {
      for z in 0...50 {
        advisor.observe(point: SIMD3<Float>(Float(x) * 0.2, 0, Float(z) * 0.2),
                        laxWalkable: true, strictWalkable: true, timestamp: 1)
      }
    }
    let open = advisor.recommendation(origin: origin, forward: forward, right: right, timestamp: 1)
    precondition(open != nil && abs(open!.headingDegrees) < 10, "Open corridor should guide forward")
    let turned = advisor.recommendation(origin: origin, forward: right, right: -forward, timestamp: 1.1)
    precondition(turned == nil, "Turning the phone must invalidate the cached relative heading")
    let stale = advisor.recommendation(origin: origin, forward: forward, right: right, timestamp: 3)
    precondition(stale == nil, "Expired observations must not guide")
    advisor.reset()
    precondition(advisor.recommendation(origin: origin, forward: forward, right: right, timestamp: 3) == nil)

    let planner = LocalRoutePlanner()
    for x in -20...20 {
      for z in 1...35 {
        planner.observeRay(from: origin, to: SIMD3<Float>(Float(x) * 0.1, 0, Float(z) * 0.1),
                           isObstacle: false, isPerson: false, timestamp: 1)
      }
    }
    let clear = planner.guidance(cameraPosition: origin, forward: forward, right: right, timestamp: 1)
    precondition(clear["instruction"] as? String == "straight", "Observed corridor must pass line search")
    // Close the corridor ahead and on both sides.
    for x in -40...40 {
      planner.observeRay(from: origin, to: SIMD3<Float>(Float(x) * 0.1, 0, 0.8),
                         isObstacle: true, isPerson: false, timestamp: 1.1)
      planner.observeRay(from: origin, to: SIMD3<Float>(Float(x) * 0.1, 0, 0.8),
                         isObstacle: true, isPerson: false, timestamp: 1.1)
    }
    for z in 0...35 {
      for x: Float in [-0.6, 0.6] {
        planner.observeRay(from: origin, to: SIMD3<Float>(x, 0, Float(z) * 0.1),
                           isObstacle: true, isPerson: false, timestamp: 1.1)
      }
    }
    let wall = planner.guidance(cameraPosition: origin, forward: forward, right: right, timestamp: 1.1)
    precondition(wall["instruction"] as? String == "stop", "Wall must stop guidance")
    planner.reset()
    let unknown = planner.guidance(cameraPosition: origin, forward: forward, right: right, timestamp: 2)
    precondition(unknown["instruction"] as? String == "hold", "Unknown space must not authorize motion")
    print("Mobilio native checks passed: corridor, expiry, reset, wall, unknown space")
  }
}
