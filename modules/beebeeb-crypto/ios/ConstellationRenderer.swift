import ExpoModulesCore
import SceneKit
import UIKit

// MARK: - Data types (mirrors Rust ConstellationFrame)

struct ConstellationNodeData {
  let kind: Int        // 0 = outer, 1 = core
  let x: Float
  let y: Float
  let z: Float
  let brightness: Float
  let pulsePhase: Float
}

struct ConstellationEdgeData {
  let fromIdx: Int
  let toIdx: Int
  let weight: Float
  let flowSpeed: Float
}

struct ConstellationFrameData {
  let frameIndex: Int
  let seed: Int64
  let ringPhase: Float
  let nodes: [ConstellationNodeData]
  let edges: [ConstellationEdgeData]
}

// MARK: - Module (registers the view with Expo)

public class ConstellationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ConstellationModule")

    View(ConstellationView.self) {
      Prop("frame") { (view: ConstellationView, frame: [String: Any]?) in
        guard let frame, let parsed = ConstellationView.parseFrame(frame) else { return }
        view.updateFrame(parsed)
      }
    }
  }
}

// MARK: - ConstellationView

private let kNodeScale: Float = 2.2
private let kMaxEdges = 250
private let kNodeCount = 67

public class ConstellationView: ExpoView {
  private let sceneView: SCNView = {
    let opts: [String: Any] = [SCNView.Option.preferredRenderingAPI.rawValue: SCNRenderingAPI.metal.rawValue]
    return SCNView(frame: .zero, options: opts)
  }()
  private let scene = SCNScene()
  private var nodeSceneNodes: [SCNNode] = []
  private var edgeSceneNodes: [SCNNode] = []
  private var ringNode: SCNNode?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    setupSceneView()
    setupCamera()
    setupLights()
    setupNodePool()
    setupEdgePool()
    setupRing()
    setupSparkles()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    sceneView.frame = bounds
  }

  // MARK: - Scene setup

  private func setupSceneView() {
    sceneView.backgroundColor = .black
    sceneView.autoenablesDefaultLighting = false
    sceneView.antialiasingMode = .multisampling4X
    sceneView.rendersContinuously = false  // only re-render when frame is pushed
    sceneView.scene = scene
    addSubview(sceneView)
  }

  private func setupCamera() {
    let camera = SCNCamera()
    camera.fieldOfView = 60
    camera.zNear = 0.1
    camera.zFar = 100
    // Depth of field — nodes at the back are softly blurred
    camera.wantsDepthOfField = true
    camera.focusDistance = 5.0
    camera.fStop = 1.4
    camera.focalBlurSampleCount = 16

    let cameraNode = SCNNode()
    cameraNode.camera = camera
    cameraNode.position = SCNVector3(0, 0, 7)
    scene.rootNode.addChildNode(cameraNode)
  }

  private func setupLights() {
    // Ambient — soft dark fill so depth reads correctly
    let ambient = SCNLight()
    ambient.type = .ambient
    ambient.color = UIColor(white: 0.08, alpha: 1.0)
    let ambientNode = SCNNode()
    ambientNode.light = ambient
    scene.rootNode.addChildNode(ambientNode)

    // Key light — warm directional from upper-right
    let key = SCNLight()
    key.type = .directional
    key.color = UIColor(red: 1.0, green: 0.95, blue: 0.82, alpha: 1.0)
    key.intensity = 900
    let keyNode = SCNNode()
    keyNode.light = key
    keyNode.eulerAngles = SCNVector3(-Float.pi / 4, Float.pi / 6, 0)
    scene.rootNode.addChildNode(keyNode)

    // Fill — cool blue bounce from lower-left
    let fill = SCNLight()
    fill.type = .directional
    fill.color = UIColor(red: 0.18, green: 0.28, blue: 0.5, alpha: 1.0)
    fill.intensity = 350
    let fillNode = SCNNode()
    fillNode.light = fill
    fillNode.eulerAngles = SCNVector3(Float.pi / 8, -Float.pi * 0.75, 0)
    scene.rootNode.addChildNode(fillNode)
  }

  private func setupNodePool() {
    for _ in 0..<kNodeCount {
      let sphere = SCNSphere(radius: 1.0)   // scaled per-frame via node.scale
      sphere.segmentCount = 14

      let mat = SCNMaterial()
      mat.lightingModel = .physicallyBased
      mat.diffuse.contents = amber(1.0)
      mat.metalness.contents = NSNumber(value: 0.3)
      mat.roughness.contents = NSNumber(value: 0.1)
      mat.emission.contents = amber(0.35)
      sphere.materials = [mat]

      let node = SCNNode(geometry: sphere)
      node.isHidden = true
      scene.rootNode.addChildNode(node)
      nodeSceneNodes.append(node)
    }
  }

  private func setupEdgePool() {
    for _ in 0..<kMaxEdges {
      // Unit-height cylinder — height set dynamically via geometry or scale
      let cylinder = SCNCylinder(radius: 0.008, height: 1.0)
      cylinder.segmentCount = 4

      let mat = SCNMaterial()
      mat.lightingModel = .physicallyBased
      mat.diffuse.contents = amber(0.55)
      mat.metalness.contents = NSNumber(value: 0.15)
      mat.roughness.contents = NSNumber(value: 0.4)
      mat.emission.contents = amber(0.12)
      mat.isDoubleSided = true
      cylinder.materials = [mat]

      let node = SCNNode(geometry: cylinder)
      node.isHidden = true
      scene.rootNode.addChildNode(node)
      edgeSceneNodes.append(node)
    }
  }

  private func setupRing() {
    let torus = SCNTorus(ringRadius: 2.85, pipeRadius: 0.016)
    let mat = SCNMaterial()
    mat.lightingModel = .physicallyBased
    mat.diffuse.contents = amber(0.65)
    mat.metalness.contents = NSNumber(value: 0.6)
    mat.roughness.contents = NSNumber(value: 0.12)
    mat.emission.contents = amber(0.18)
    mat.transparency = 0.25
    mat.isDoubleSided = true
    torus.materials = [mat]

    let ring = SCNNode(geometry: torus)
    // Tilt ring to face camera slightly
    ring.eulerAngles = SCNVector3(Float.pi / 2 + 0.15, 0, 0)
    scene.rootNode.addChildNode(ring)
    ringNode = ring

    // Slow continuous rotation
    let spin = SCNAction.repeatForever(SCNAction.rotateBy(x: 0, y: CGFloat.pi * 2, z: 0, duration: 22))
    ring.runAction(spin)

    addHashLabels(to: ring)
  }

  private func addHashLabels(to ring: SCNNode) {
    let snippet = "A3F9·B2E7·D1C4·0826·95FA·8C1D"
    let chunks = snippet.components(separatedBy: "·")
    let count = chunks.count

    for (i, chunk) in chunks.enumerated() {
      let angle = Float(i) * Float.pi * 2.0 / Float(count)
      let r: Float = 2.88
      let x = r * cos(angle)
      let z = r * sin(angle)

      let text = SCNText(string: chunk, extrusionDepth: 0.004)
      text.font = UIFont.monospacedSystemFont(ofSize: 0.10, weight: .light)
      text.flatness = 0.05

      let textMat = SCNMaterial()
      textMat.lightingModel = .physicallyBased
      textMat.diffuse.contents = amber(0.75)
      textMat.emission.contents = amber(0.35)
      text.materials = [textMat]

      // Center the text bounding box
      let (minBound, maxBound) = text.boundingBox
      let offsetX = -(maxBound.x - minBound.x) / 2
      let offsetY = -(maxBound.y - minBound.y) / 2

      let textNode = SCNNode(geometry: text)
      textNode.position = SCNVector3(x + offsetX, offsetY, z)
      textNode.eulerAngles = SCNVector3(0, -(angle - Float.pi / 2), 0)
      ring.addChildNode(textNode)
    }
  }

  private func setupSparkles() {
    let ps = SCNParticleSystem()
    ps.particleColor = amber(0.85)
    ps.particleColorVariation = SCNVector4(0.04, 0.08, 0.04, 0.15)
    ps.particleSize = 0.022
    ps.particleSizeVariation = 0.012
    ps.birthRate = 28
    ps.particleLifeSpan = 1.6
    ps.particleLifeSpanVariation = 0.6
    ps.particleVelocity = 0.25
    ps.particleVelocityVariation = 0.12
    ps.spreadingAngle = 70
    ps.isAffectedByGravity = false
    ps.blendMode = .additive
    ps.emitterShape = SCNSphere(radius: 2.3)

    let sparkleNode = SCNNode()
    sparkleNode.addParticleSystem(ps)
    scene.rootNode.addChildNode(sparkleNode)
  }

  // MARK: - Frame application

  public func updateFrame(_ frame: ConstellationFrameData) {
    DispatchQueue.main.async { [weak self] in
      self?.applyFrame(frame)
      self?.sceneView.rendersContinuously = false
    }
  }

  private func applyFrame(_ frame: ConstellationFrameData) {
    // Nodes
    for (i, nd) in frame.nodes.enumerated() {
      guard i < nodeSceneNodes.count else { break }
      let sn = nodeSceneNodes[i]
      sn.isHidden = false
      sn.position = SCNVector3(nd.x * kNodeScale, nd.y * kNodeScale, nd.z * kNodeScale)

      let brightness = max(0.05, min(1.0, nd.brightness))
      let baseR: Float = nd.kind == 1 ? 0.072 : 0.040
      let r = baseR + brightness * 0.042
      sn.scale = SCNVector3(r, r, r)

      if let mat = sn.geometry?.firstMaterial {
        let glow = 0.18 + brightness * 0.65
        mat.emission.contents = amber(glow)
        let pulse = (sin(nd.pulsePhase) + 1.0) / 2.0
        mat.diffuse.contents = amber(0.55 + pulse * 0.45)
      }
    }
    for i in frame.nodes.count..<nodeSceneNodes.count {
      nodeSceneNodes[i].isHidden = true
    }

    // Edges
    for (i, ed) in frame.edges.enumerated() {
      guard i < edgeSceneNodes.count else { break }
      guard ed.fromIdx < frame.nodes.count, ed.toIdx < frame.nodes.count else {
        edgeSceneNodes[i].isHidden = true
        continue
      }
      let fn = frame.nodes[ed.fromIdx]
      let tn = frame.nodes[ed.toIdx]
      let start = SCNVector3(fn.x * kNodeScale, fn.y * kNodeScale, fn.z * kNodeScale)
      let end   = SCNVector3(tn.x * kNodeScale, tn.y * kNodeScale, tn.z * kNodeScale)

      let en = edgeSceneNodes[i]
      let (pos, rot, h) = cylinderTransform(from: start, to: end)
      en.position = pos
      en.rotation = rot

      if let cyl = en.geometry as? SCNCylinder {
        cyl.height = CGFloat(max(h, 0.001))
        if let mat = cyl.firstMaterial {
          let alpha = 0.18 + ed.weight * 0.42
          mat.diffuse.contents = amber(alpha)
          mat.emission.contents = amber(alpha * 0.25)
        }
      }
      en.isHidden = false
    }
    for i in frame.edges.count..<edgeSceneNodes.count {
      edgeSceneNodes[i].isHidden = true
    }
  }

  // MARK: - Geometry helpers

  private func cylinderTransform(
    from start: SCNVector3, to end: SCNVector3
  ) -> (SCNVector3, SCNVector4, Float) {
    let dx = end.x - start.x
    let dy = end.y - start.y
    let dz = end.z - start.z
    let length = (dx*dx + dy*dy + dz*dz).squareRoot()
    guard length > 0.001 else { return (start, SCNVector4(0, 1, 0, 0), 0.001) }

    let mid = SCNVector3((start.x+end.x)/2, (start.y+end.y)/2, (start.z+end.z)/2)
    let dirY = dy / length
    let dirX = dx / length
    let dirZ = dz / length

    // Rotation axis: cross(yAxis, dir) = (dirZ, 0, -dirX)
    let axX = dirZ
    let axZ = -dirX
    let axLen = (axX*axX + axZ*axZ).squareRoot()
    let angle = acos(min(max(dirY, -1.0), 1.0))

    if axLen < 0.001 {
      let flip: Float = dirY > 0 ? 0 : Float.pi
      return (mid, SCNVector4(1, 0, 0, flip), length)
    }
    return (mid, SCNVector4(axX/axLen, 0, axZ/axLen, angle), length)
  }

  // MARK: - Color helper

  private func amber(_ alpha: Float) -> UIColor {
    UIColor(red: 0.961, green: 0.722, blue: 0.0, alpha: CGFloat(alpha))
  }

  // MARK: - Frame parsing (called from Prop handler)

  static func parseFrame(_ dict: [String: Any]) -> ConstellationFrameData? {
    guard let nodesRaw = dict["nodes"] as? [[String: Any]],
          let edgesRaw = dict["edges"] as? [[String: Any]] else { return nil }

    let frameIndex = dict["frameIndex"] as? Int ?? 0
    let seed       = (dict["seed"] as? NSNumber)?.int64Value ?? 0
    let ringPhase  = (dict["ringPhase"] as? NSNumber)?.floatValue ?? 0

    let nodes: [ConstellationNodeData] = nodesRaw.compactMap { n in
      guard let x  = (n["x"]          as? NSNumber)?.floatValue,
            let y  = (n["y"]          as? NSNumber)?.floatValue,
            let z  = (n["z"]          as? NSNumber)?.floatValue,
            let br = (n["brightness"] as? NSNumber)?.floatValue,
            let pp = (n["pulsePhase"] as? NSNumber)?.floatValue
      else { return nil }
      return ConstellationNodeData(
        kind: n["kind"] as? Int ?? 0,
        x: x, y: y, z: z,
        brightness: br, pulsePhase: pp
      )
    }

    let edges: [ConstellationEdgeData] = edgesRaw.compactMap { e in
      guard let fi = e["fromIdx"]   as? Int,
            let ti = e["toIdx"]     as? Int,
            let w  = (e["weight"]   as? NSNumber)?.floatValue,
            let fs = (e["flowSpeed"] as? NSNumber)?.floatValue
      else { return nil }
      return ConstellationEdgeData(fromIdx: fi, toIdx: ti, weight: w, flowSpeed: fs)
    }

    return ConstellationFrameData(
      frameIndex: frameIndex, seed: seed, ringPhase: ringPhase,
      nodes: nodes, edges: edges
    )
  }
}
