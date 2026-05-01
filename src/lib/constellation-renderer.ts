/**
 * Amber Constellation — WebView renderer.
 *
 * Returns a self-contained HTML document that loads Three.js from a CDN and
 * draws the animated constellation: 55 outer + 12 inner amber nodes on
 * fibonacci spheres, edges between nearby nodes, a breathing ring, and
 * ambient amber dust. React Native pushes per-frame brightness updates via
 * `webViewRef.current.postMessage(JSON.stringify(frame))`; the page listens on
 * `window.addEventListener('message', ...)` and applies them to the live scene.
 */

export interface ConstellationRendererOptions {
  /** Background color hex. Defaults to #0C0C0D. */
  background?: string
  /** Three.js CDN URL. Pinned to a known r158 build by default. */
  threeCdn?: string
  /** Initial node count for the outer sphere (kind=0). */
  outerNodeCount?: number
  /** Initial node count for the inner core (kind=1). */
  innerNodeCount?: number
  /** Maximum edges drawn. The renderer draws min(frame.edges.length, maxEdges). */
  maxEdges?: number
  /** Number of ambient dust particles. */
  particleCount?: number
}

const DEFAULTS: Required<ConstellationRendererOptions> = {
  background: '#0C0C0D',
  threeCdn: 'https://unpkg.com/three@0.158.0/build/three.min.js',
  outerNodeCount: 55,
  innerNodeCount: 12,
  maxEdges: 220,
  particleCount: 600,
}

export function generateConstellationHTML(options: ConstellationRendererOptions = {}): string {
  const cfg = { ...DEFAULTS, ...options }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover" />
<title>Constellation</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; width: 100%; background: ${cfg.background}; overflow: hidden; }
  body { -webkit-tap-highlight-color: transparent; }
  #canvas { display: block; width: 100vw; height: 100vh; }
  #fallback {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: #f5b800; font-family: -apple-system, system-ui, sans-serif; font-size: 13px;
    letter-spacing: 0.5px; opacity: 0.7;
  }
  .hidden { display: none !important; }
</style>
</head>
<body>
<canvas id="canvas"></canvas>
<div id="fallback">Initialising constellation…</div>
<script src="${cfg.threeCdn}" crossorigin="anonymous"></script>
<script>
(function () {
  'use strict';

  var BG = ${JSON.stringify(cfg.background)};
  var OUTER = ${cfg.outerNodeCount};
  var INNER = ${cfg.innerNodeCount};
  var NODE_COUNT = OUTER + INNER;
  var MAX_EDGES = ${cfg.maxEdges};
  var PARTICLES = ${cfg.particleCount};

  var AMBER = 0xF5B800;
  var AMBER_DEEP = 0xB8860B;
  var AMBER_BRIGHT = 0xFFD37A;

  function bail(msg) {
    var f = document.getElementById('fallback');
    if (f) { f.textContent = msg; f.style.opacity = '1'; }
  }
  if (typeof THREE === 'undefined') { bail('Three.js failed to load.'); return; }

  var canvas = document.getElementById('canvas');
  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch (e) { bail('WebGL not available.'); return; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(new THREE.Color(BG), 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  var scene = new THREE.Scene();
  scene.fog = new THREE.Fog(new THREE.Color(BG), 6.5, 14);

  var camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 6.4);

  // Subtle warm key + cool fill so the amber reads against pure black
  scene.add(new THREE.AmbientLight(0x2a2218, 0.6));
  var keyLight = new THREE.PointLight(0xffd28a, 1.2, 40);
  keyLight.position.set(4, 5, 6);
  scene.add(keyLight);
  var fillLight = new THREE.PointLight(0x4a3a2a, 0.6, 30);
  fillLight.position.set(-5, -3, 4);
  scene.add(fillLight);

  // ── Glow sprite — radial gradient texture cached once
  function makeGlowTexture() {
    var size = 128;
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
    g.addColorStop(0.00, 'rgba(255,221,140,1)');
    g.addColorStop(0.18, 'rgba(245,184,0,0.85)');
    g.addColorStop(0.45, 'rgba(184,134,11,0.35)');
    g.addColorStop(1.00, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  var glowTex = makeGlowTexture();

  // ── Geometry: deterministic fibonacci sphere positions for fallback / initial
  function fibonacciSphere(n, radius) {
    var pts = [];
    if (n <= 0) return pts;
    var ga = Math.PI * (3 - Math.sqrt(5));
    for (var i = 0; i < n; i++) {
      var y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
      var r = Math.sqrt(Math.max(0, 1 - y*y));
      var theta = ga * i;
      pts.push({ x: Math.cos(theta) * r * radius, y: y * radius, z: Math.sin(theta) * r * radius });
    }
    return pts;
  }
  var initialOuter = fibonacciSphere(OUTER, 1.55);
  var initialInner = fibonacciSphere(INNER, 0.65);
  var initialPositions = initialOuter.concat(initialInner);

  // ── Root group (rotates slowly)
  var root = new THREE.Group();
  scene.add(root);

  // ── Nodes: solid emissive sphere + glow sprite, grouped per node so we can scale the halo independently
  var nodeGroups = [];
  var nodeMaterials = [];
  var glowMaterials = [];
  var outerGeo = new THREE.SphereGeometry(0.038, 16, 16);
  var innerGeo = new THREE.SphereGeometry(0.072, 24, 24);

  for (var i = 0; i < NODE_COUNT; i++) {
    var isCore = i >= OUTER;
    var mat = new THREE.MeshStandardMaterial({
      color: 0x1a1208,
      emissive: AMBER,
      emissiveIntensity: 1.0,
      roughness: 0.35,
      metalness: 0.0,
    });
    var mesh = new THREE.Mesh(isCore ? innerGeo : outerGeo, mat);
    var glowMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: AMBER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.9,
    });
    var glow = new THREE.Sprite(glowMat);
    glow.scale.set(isCore ? 0.95 : 0.55, isCore ? 0.95 : 0.55, 1);
    var grp = new THREE.Group();
    grp.add(mesh);
    grp.add(glow);
    var p = initialPositions[i];
    grp.position.set(p.x, p.y, p.z);
    root.add(grp);
    nodeGroups.push(grp);
    nodeMaterials.push(mat);
    glowMaterials.push(glowMat);
  }

  // ── Edges: a single LineSegments with vertex colors, capacity MAX_EDGES
  var edgeGeometry = new THREE.BufferGeometry();
  var edgePositions = new Float32Array(MAX_EDGES * 6);
  var edgeColors = new Float32Array(MAX_EDGES * 6);
  edgeGeometry.setAttribute('position', new THREE.BufferAttribute(edgePositions, 3));
  edgeGeometry.setAttribute('color', new THREE.BufferAttribute(edgeColors, 3));
  var edgeMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.65,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  var edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  root.add(edgeLines);

  // Pre-compute initial neighbour edges (k=3 nearest) so the scene has
  // structure even before the first frame arrives.
  function buildInitialEdges() {
    var k = 3;
    var written = 0;
    for (var i = 0; i < NODE_COUNT && written < MAX_EDGES; i++) {
      var pi = initialPositions[i];
      var dists = [];
      for (var j = 0; j < NODE_COUNT; j++) {
        if (j === i) continue;
        var pj = initialPositions[j];
        var dx = pi.x - pj.x, dy = pi.y - pj.y, dz = pi.z - pj.z;
        dists.push({ j: j, d: dx*dx + dy*dy + dz*dz });
      }
      dists.sort(function (a, b) { return a.d - b.d; });
      for (var n = 0; n < k && written < MAX_EDGES; n++) {
        var j2 = dists[n].j;
        if (j2 < i) continue; // each pair once
        var pj2 = initialPositions[j2];
        var off = written * 6;
        edgePositions[off + 0] = pi.x;  edgePositions[off + 1] = pi.y;  edgePositions[off + 2] = pi.z;
        edgePositions[off + 3] = pj2.x; edgePositions[off + 4] = pj2.y; edgePositions[off + 5] = pj2.z;
        // Soft amber start
        var r = 0.96, g = 0.72, b = 0.0;
        edgeColors[off + 0] = r * 0.35; edgeColors[off + 1] = g * 0.35; edgeColors[off + 2] = b * 0.35;
        edgeColors[off + 3] = r * 0.35; edgeColors[off + 4] = g * 0.35; edgeColors[off + 5] = b * 0.35;
        written++;
      }
    }
    edgeGeometry.setDrawRange(0, written * 2);
    edgeGeometry.attributes.position.needsUpdate = true;
    edgeGeometry.attributes.color.needsUpdate = true;
  }
  buildInitialEdges();

  // ── Breathing ring around the sphere
  var ringGeo = new THREE.RingGeometry(2.05, 2.09, 192);
  var ringMat = new THREE.MeshBasicMaterial({
    color: AMBER_DEEP, transparent: true, opacity: 0.22, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  var ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -0.12;
  scene.add(ring);

  // Outer halo ring (wider, dimmer, slower)
  var ring2Geo = new THREE.RingGeometry(2.55, 2.62, 192);
  var ring2Mat = new THREE.MeshBasicMaterial({
    color: AMBER_DEEP, transparent: true, opacity: 0.08, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  var ring2 = new THREE.Mesh(ring2Geo, ring2Mat);
  ring2.rotation.x = -0.12;
  scene.add(ring2);

  // ── Ambient amber dust particles
  var particleGeo = new THREE.BufferGeometry();
  var particlePos = new Float32Array(PARTICLES * 3);
  var particleSpeed = new Float32Array(PARTICLES);
  for (var p = 0; p < PARTICLES; p++) {
    // Spherical shell around the sphere, slightly biased outward
    var theta = Math.random() * Math.PI * 2;
    var phi = Math.acos(2 * Math.random() - 1);
    var rr = 2.2 + Math.random() * 3.3;
    particlePos[p*3 + 0] = rr * Math.sin(phi) * Math.cos(theta);
    particlePos[p*3 + 1] = rr * Math.sin(phi) * Math.sin(theta);
    particlePos[p*3 + 2] = rr * Math.cos(phi);
    particleSpeed[p] = 0.05 + Math.random() * 0.18;
  }
  particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePos, 3));
  var particleMat = new THREE.PointsMaterial({
    color: AMBER,
    size: 0.022,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  var particles = new THREE.Points(particleGeo, particleMat);
  scene.add(particles);

  // ── Frame application
  var pendingFrame = null;

  function applyFrame(frame) {
    var nodes = frame.nodes || [];
    var edges = frame.edges || [];

    // Update node positions, brightness, and glow scale
    for (var i = 0; i < NODE_COUNT; i++) {
      var n = nodes[i];
      if (!n) continue;
      var grp = nodeGroups[i];
      grp.position.set(n.x, n.y, n.z);
      var b = Math.max(0, Math.min(1, n.brightness || 0));
      var pulse = 0.5 + 0.5 * Math.sin(n.pulsePhase || 0);
      var lit = 0.35 + 1.85 * b + 0.25 * pulse;
      nodeMaterials[i].emissiveIntensity = lit;
      // Color shifts subtly toward bright amber as brightness rises
      var colorMix = b > 0.7 ? AMBER_BRIGHT : AMBER;
      nodeMaterials[i].emissive.setHex(colorMix);
      glowMaterials[i].opacity = 0.3 + 0.7 * b;
      glowMaterials[i].color.setHex(colorMix);
      var isCore = i >= OUTER;
      var baseHalo = isCore ? 0.95 : 0.55;
      var haloScale = baseHalo * (0.6 + 1.0 * b + 0.15 * pulse);
      grp.children[1].scale.set(haloScale, haloScale, 1);
      grp.children[0].scale.setScalar(0.85 + 0.5 * b);
    }

    // Update edges
    var edgeCount = Math.min(edges.length, MAX_EDGES);
    for (var e = 0; e < edgeCount; e++) {
      var ed = edges[e];
      var a = nodes[ed.fromIdx], c = nodes[ed.toIdx];
      if (!a || !c) {
        var off0 = e * 6;
        edgePositions[off0+0]=0; edgePositions[off0+1]=0; edgePositions[off0+2]=0;
        edgePositions[off0+3]=0; edgePositions[off0+4]=0; edgePositions[off0+5]=0;
        edgeColors[off0+0]=0; edgeColors[off0+1]=0; edgeColors[off0+2]=0;
        edgeColors[off0+3]=0; edgeColors[off0+4]=0; edgeColors[off0+5]=0;
        continue;
      }
      var off = e * 6;
      edgePositions[off+0] = a.x; edgePositions[off+1] = a.y; edgePositions[off+2] = a.z;
      edgePositions[off+3] = c.x; edgePositions[off+4] = c.y; edgePositions[off+5] = c.z;
      var w = Math.max(0, Math.min(1, ed.weight || 0));
      // Amber colour scaled by weight; flow speed shifts hue subtly
      var rr = 0.96 * (0.25 + 0.75 * w);
      var gg = 0.72 * (0.25 + 0.75 * w);
      var bb = 0.05 + 0.10 * (ed.flowSpeed || 0);
      edgeColors[off+0] = rr; edgeColors[off+1] = gg; edgeColors[off+2] = bb;
      edgeColors[off+3] = rr; edgeColors[off+4] = gg; edgeColors[off+5] = bb;
    }
    // Zero unused edge slots within the active range
    for (var z = edgeCount; z < MAX_EDGES; z++) {
      var oz = z * 6;
      edgePositions[oz+0]=0; edgePositions[oz+1]=0; edgePositions[oz+2]=0;
      edgePositions[oz+3]=0; edgePositions[oz+4]=0; edgePositions[oz+5]=0;
      edgeColors[oz+0]=0; edgeColors[oz+1]=0; edgeColors[oz+2]=0;
      edgeColors[oz+3]=0; edgeColors[oz+4]=0; edgeColors[oz+5]=0;
    }
    edgeGeometry.setDrawRange(0, edgeCount * 2);
    edgeGeometry.attributes.position.needsUpdate = true;
    edgeGeometry.attributes.color.needsUpdate = true;

    // Ring breathing — driven by frame.ringPhase if present
    var phase = (typeof frame.ringPhase === 'number') ? frame.ringPhase : 0;
    ringMat.opacity = 0.14 + 0.16 * (0.5 + 0.5 * Math.sin(phase));
    ring2Mat.opacity = 0.05 + 0.08 * (0.5 + 0.5 * Math.sin(phase * 0.7 + 1.2));
  }

  // ── Bridge: receive frames from React Native via postMessage
  function handleMessage(ev) {
    if (!ev || typeof ev.data !== 'string') return;
    try {
      var parsed = JSON.parse(ev.data);
      // Accept either a wrapped {type:'frame', frame:{...}} or a bare frame object
      if (parsed && parsed.type === 'frame' && parsed.frame) { pendingFrame = parsed.frame; return; }
      if (parsed && Array.isArray(parsed.nodes)) { pendingFrame = parsed; return; }
    } catch (_) { /* ignore non-JSON */ }
  }
  window.addEventListener('message', handleMessage);
  document.addEventListener('message', handleMessage); // Android compatibility

  // ── Resize
  function onResize() {
    var w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  window.addEventListener('resize', onResize);

  // ── Animation loop
  var clock = new THREE.Clock();
  var elapsed = 0;
  var fallback = document.getElementById('fallback');
  var hidFallback = false;

  function tick() {
    requestAnimationFrame(tick);
    var dt = Math.min(clock.getDelta(), 0.05);
    elapsed += dt;

    // Slow continuous rotation
    root.rotation.y += dt * (Math.PI / 22); // ~8 deg/s
    root.rotation.x += dt * (Math.PI / 50); // ~3.6 deg/s

    // Ring rotation (slower, opposite axis bias)
    ring.rotation.z += dt * (Math.PI / 90);
    ring2.rotation.z -= dt * (Math.PI / 140);

    // Particles drift outward slowly, then wrap back to inner shell
    var pAttr = particleGeo.attributes.position;
    var arr = pAttr.array;
    for (var k = 0; k < PARTICLES; k++) {
      var ix = k * 3;
      var x = arr[ix], y = arr[ix+1], z = arr[ix+2];
      var len = Math.sqrt(x*x + y*y + z*z) || 1;
      var v = particleSpeed[k] * dt;
      arr[ix]   = x + (x / len) * v;
      arr[ix+1] = y + (y / len) * v;
      arr[ix+2] = z + (z / len) * v;
      if (len > 5.6) {
        // Recycle: respawn near inner shell
        var theta = Math.random() * Math.PI * 2;
        var phi = Math.acos(2 * Math.random() - 1);
        var rr = 2.2 + Math.random() * 0.4;
        arr[ix]   = rr * Math.sin(phi) * Math.cos(theta);
        arr[ix+1] = rr * Math.sin(phi) * Math.sin(theta);
        arr[ix+2] = rr * Math.cos(phi);
      }
    }
    pAttr.needsUpdate = true;
    particleMat.opacity = 0.4 + 0.2 * Math.sin(elapsed * 0.6);

    // Idle pulse before frames arrive — keeps the scene alive and inviting
    if (!pendingFrame) {
      for (var ni = 0; ni < NODE_COUNT; ni++) {
        var idle = 0.5 + 0.5 * Math.sin(elapsed * 0.9 + ni * 0.21);
        nodeMaterials[ni].emissiveIntensity = 0.45 + 0.85 * idle;
        glowMaterials[ni].opacity = 0.32 + 0.45 * idle;
      }
      ringMat.opacity = 0.16 + 0.12 * Math.sin(elapsed * 0.7);
      ring2Mat.opacity = 0.06 + 0.08 * Math.sin(elapsed * 0.5 + 1.4);
    } else {
      applyFrame(pendingFrame);
      pendingFrame = null;
    }

    if (!hidFallback && elapsed > 0.25) {
      hidFallback = true;
      if (fallback) fallback.classList.add('hidden');
    }
    renderer.render(scene, camera);
  }
  tick();

  // Tell RN we're ready to receive frames
  try {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
    }
  } catch (_) {}
})();
</script>
</body>
</html>`
}
