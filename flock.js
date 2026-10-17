// A small flock of paper birds ("nokka" = beak) drifting behind the page.
// Boids: separation, alignment, cohesion, plus a slow wandering goal and a
// soft keep-out around the headline. The cursor gently draws them in; a click
// or tap scatters them.
import * as THREE from "three";

const canvas = document.getElementById("sky");
const hint = document.getElementById("hint");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const darkQuery = matchMedia("(prefers-color-scheme: dark)");

const SETTINGS = {
  perception: 7,
  separation: 2.6,
  wSeparation: 26,
  wAlignment: 2.4,
  wCohesion: 0.9,
  wWander: 0.35,
  minSpeed: 6.5,
  maxSpeed: 14,
  edgePush: 3,
  keepOut: 9,
  attractRadius: 26,
  attract: 14,
  scatterRadius: 32,
  scatter: 260,
  depth: 22,
  front: 6,
  scale: 0.85,
  cameraZ: 70,
  parallax: 4,
};

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function birdGeometry() {
  // Forward is +Z (Object3D.lookAt points +Z at the target).
  // Each wing folds once: the inner panel lifts a little, the tip a lot.
  const nose = [0, 0, 1.35];
  const tail = [0, 0.04, -1.0];
  const keel = [0, -0.3, -0.05];
  const elbowL = [-0.72, 0.08, -0.12];
  const tipL = [-1.55, 0.12, -0.72];
  const elbowR = [0.72, 0.08, -0.12];
  const tipR = [1.55, 0.12, -0.72];
  const weight = new Map([[elbowL, 0.45], [elbowR, 0.45], [tipL, 1], [tipR, 1]]);
  const tris = [
    [nose, elbowL, tail],
    [elbowL, tipL, tail],
    [nose, tail, elbowR],
    [elbowR, tail, tipR],
    [nose, keel, tail],
  ];
  const positions = [];
  const wing = [];
  for (const tri of tris) {
    for (const v of tri) {
      positions.push(...v);
      wing.push(weight.get(v) ?? 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("aWing", new THREE.Float32BufferAttribute(wing, 1));
  g.computeVertexNormals();
  return g;
}

function start() {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    canvas.remove();
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const S = SETTINGS;
  const scene = new THREE.Scene();
  // Birds live between z = -depth and z = +front; the far ones fade into the page.
  scene.fog = new THREE.Fog(0xffffff, S.cameraZ - S.front - 4, S.cameraZ + S.depth * 2);
  const camera = new THREE.PerspectiveCamera(42, 1, 1, 400);
  camera.position.z = S.cameraZ;

  const hemi = new THREE.HemisphereLight(0xffffff, 0xb8b0a4, 2.2);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff4e6, 1.5);
  sun.position.set(-4, 7, 5);
  scene.add(sun);

  const count = innerWidth < 700 ? 70 : 140;
  const geometry = birdGeometry();
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) phase[i] = Math.random() * Math.PI * 2;
  const phaseAttr = new THREE.InstancedBufferAttribute(phase, 1);
  phaseAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("aPhase", phaseAttr);

  const uniforms = { uFlap: { value: 0.6 } };
  const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, flatShading: true });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFlap = uniforms.uFlap;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "attribute float aWing;\nattribute float aPhase;\nuniform float uFlap;\n#include <common>")
      .replace(
        "#include <begin_vertex>",
        // The tip trails the elbow slightly, which reads as a soft wing wave.
        "#include <begin_vertex>\nfloat s = sin(aPhase - aWing * 0.9);\ntransformed.y += s * uFlap * aWing;\ntransformed.x *= 1.0 - 0.16 * aWing * abs(s);"
      );
  };

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const accentEvery = 17;
  const shade = Array.from({ length: count }, () => (Math.random() - 0.5) * 0.06);
  const applyTheme = () => {
    const base = new THREE.Color(cssVar("--bird"));
    const accent = new THREE.Color(cssVar("--accent"));
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      if (i % accentEvery === 0) c.copy(accent);
      else c.copy(base).offsetHSL(0, 0, shade[i]);
      mesh.setColorAt(i, c);
    }
    mesh.instanceColor.needsUpdate = true;
    scene.fog.color.set(cssVar("--bg"));
  };
  applyTheme();

  // World-space extents of the view at z = 0, and the headline's keep-out box.
  const bounds = new THREE.Vector3();
  const halfView = new THREE.Vector2();
  const keepOut = new THREE.Box2();
  const textEls = [...document.querySelectorAll("main h1, main .tagline, main .mail")];
  const measureText = () => {
    keepOut.makeEmpty();
    for (const el of textEls) {
      const r = el.getBoundingClientRect();
      keepOut.expandByPoint(new THREE.Vector2(
        (r.left / innerWidth) * 2 * halfView.x - halfView.x,
        halfView.y - (r.top / innerHeight) * 2 * halfView.y
      ));
      keepOut.expandByPoint(new THREE.Vector2(
        (r.right / innerWidth) * 2 * halfView.x - halfView.x,
        halfView.y - (r.bottom / innerHeight) * 2 * halfView.y
      ));
    }
    if (!keepOut.isEmpty()) keepOut.expandByScalar(1.5);
  };
  const resize = () => {
    const w = innerWidth;
    const h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    halfView.y = S.cameraZ * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    halfView.x = halfView.y * camera.aspect;
    bounds.set(halfView.x * 0.95, halfView.y * 0.9, 0);
    measureText();
  };
  resize();
  // The headline animates in and webfonts swap; measure again once settled.
  document.fonts?.ready.then(measureText);
  setTimeout(measureText, 1800);

  const pos = [];
  const vel = [];
  const heading = new Float32Array(count);
  const bank = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos.push(new THREE.Vector3(
      THREE.MathUtils.randFloatSpread(bounds.x * 2),
      THREE.MathUtils.randFloatSpread(bounds.y * 2),
      THREE.MathUtils.randFloat(-S.depth, S.front)
    ));
    const a = Math.random() * Math.PI * 2;
    vel.push(new THREE.Vector3(Math.cos(a), Math.sin(a) * 0.4, Math.random() - 0.5).setLength(S.minSpeed + 2));
    heading[i] = Math.atan2(vel[i].x, vel[i].z);
  }

  const pointer = { world: new THREE.Vector3(), ndc: new THREE.Vector2(), active: false };
  const scatter = { at: new THREE.Vector3(), t: 0 };
  const ray = new THREE.Vector3();
  const toWorld = (e, out) => {
    ray.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1, 0.5).unproject(camera);
    ray.sub(camera.position).normalize();
    return out.copy(camera.position).addScaledVector(ray, -camera.position.z / ray.z);
  };
  addEventListener("pointermove", (e) => {
    toWorld(e, pointer.world);
    pointer.ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    pointer.active = e.pointerType === "mouse";
  });
  addEventListener("pointerdown", (e) => {
    toWorld(e, scatter.at);
    scatter.t = 1;
  });
  document.addEventListener("pointerleave", () => (pointer.active = false));
  addEventListener("blur", () => (pointer.active = false));

  const sep = new THREE.Vector3();
  const ali = new THREE.Vector3();
  const coh = new THREE.Vector3();
  const acc = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const goal = new THREE.Vector3();
  const dummy = new THREE.Object3D();
  dummy.scale.setScalar(S.scale);
  let time = Math.random() * 100;

  const step = (dt) => {
    time += dt;
    // A slow Lissajous goal gives the flock somewhere to go.
    goal.set(Math.sin(time * 0.07) * bounds.x * 0.75, Math.sin(time * 0.11 + 1.3) * bounds.y * 0.7, -S.depth * 0.4 + Math.sin(time * 0.05) * S.depth * 0.3);

    for (let i = 0; i < count; i++) {
      const p = pos[i];
      const v = vel[i];
      sep.set(0, 0, 0);
      ali.set(0, 0, 0);
      coh.set(0, 0, 0);
      let n = 0;
      for (let j = 0; j < count; j++) {
        if (j === i) continue;
        const d2 = p.distanceToSquared(pos[j]);
        if (d2 > S.perception * S.perception) continue;
        ali.add(vel[j]);
        coh.add(pos[j]);
        n++;
        if (d2 < S.separation * S.separation) {
          sep.add(tmp.subVectors(p, pos[j]).divideScalar(d2 + 0.01));
        }
      }
      acc.copy(sep).multiplyScalar(S.wSeparation);
      if (n) {
        acc.addScaledVector(ali.divideScalar(n).sub(v), S.wAlignment * 0.5);
        acc.addScaledVector(coh.divideScalar(n).sub(p), S.wCohesion);
      }
      acc.addScaledVector(tmp.subVectors(goal, p), S.wWander * 0.1);

      // Soft walls.
      if (p.x > bounds.x) acc.x -= (p.x - bounds.x) * S.edgePush;
      if (p.x < -bounds.x) acc.x -= (p.x + bounds.x) * S.edgePush;
      if (p.y > bounds.y) acc.y -= (p.y - bounds.y) * S.edgePush;
      if (p.y < -bounds.y) acc.y -= (p.y + bounds.y) * S.edgePush;
      if (p.z > S.front) acc.z -= (p.z - S.front) * S.edgePush * 2;
      if (p.z < -S.depth) acc.z -= (p.z + S.depth) * S.edgePush;

      // Keep the headline clear: nudge toward the nearest vertical edge of its box.
      if (!keepOut.isEmpty() && p.x > keepOut.min.x && p.x < keepOut.max.x && p.y > keepOut.min.y && p.y < keepOut.max.y) {
        const up = keepOut.max.y - p.y;
        const down = p.y - keepOut.min.y;
        acc.y += up < down ? S.keepOut : -S.keepOut;
      }

      if (pointer.active) {
        tmp.subVectors(pointer.world, p);
        const d = tmp.length();
        if (d < S.attractRadius && d > 0.001) acc.addScaledVector(tmp, (S.attract * (1 - d / S.attractRadius)) / d);
      }
      if (scatter.t > 0) {
        tmp.subVectors(p, scatter.at);
        const d = tmp.length();
        if (d < S.scatterRadius && d > 0.001) acc.addScaledVector(tmp, (S.scatter * scatter.t * (1 - d / S.scatterRadius)) / d);
      }

      v.addScaledVector(acc, dt);
      const speed = v.length();
      const maxSpeed = S.maxSpeed * (1 + scatter.t * 1.4);
      if (speed > maxSpeed) v.multiplyScalar(maxSpeed / speed);
      else if (speed < S.minSpeed) v.multiplyScalar(S.minSpeed / Math.max(speed, 0.001));
      p.addScaledVector(v, dt);

      // Bank into turns.
      const h = Math.atan2(v.x, v.z);
      let dh = h - heading[i];
      if (dh > Math.PI) dh -= Math.PI * 2;
      if (dh < -Math.PI) dh += Math.PI * 2;
      heading[i] = h;
      const targetBank = THREE.MathUtils.clamp(-(dh / Math.max(dt, 1e-4)) * 0.35, -0.9, 0.9);
      bank[i] += (targetBank - bank[i]) * (1 - Math.exp(-dt * 5));

      // Flap faster when working hard, glide when cruising.
      phase[i] += dt * (6 + Math.min(acc.length(), 40) * 0.3);
    }
    scatter.t = Math.max(0, scatter.t - dt * 1.6);
  };

  const sync = () => {
    for (let i = 0; i < count; i++) {
      dummy.position.copy(pos[i]);
      dummy.lookAt(tmp.copy(pos[i]).add(vel[i]));
      dummy.rotateZ(bank[i]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    phaseAttr.needsUpdate = true;
  };

  const moveCamera = (dt) => {
    const k = 1 - Math.exp(-dt * 2);
    const tx = pointer.active ? pointer.ndc.x * S.parallax : 0;
    const ty = pointer.active ? pointer.ndc.y * S.parallax * 0.6 : 0;
    camera.position.x += (tx - camera.position.x) * k;
    camera.position.y += (ty - camera.position.y) * k;
    camera.lookAt(0, 0, 0);
  };

  const show = () => requestAnimationFrame(() => canvas.classList.add("on"));

  darkQuery.addEventListener("change", applyTheme);

  // Let the flock form before the first frame.
  for (let k = 0; k < 300; k++) step(1 / 60);

  if (reduceMotion) {
    sync();
    renderer.render(scene, camera);
    addEventListener("resize", () => {
      resize();
      renderer.render(scene, camera);
    });
    show();
    return;
  }

  addEventListener("resize", resize);
  if (hint) hint.textContent = matchMedia("(hover: hover)").matches ? "Click to scatter" : "Tap to scatter";

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 1 / 30);
    step(dt);
    moveCamera(dt);
    sync();
    renderer.render(scene, camera);
  });
  show();
}

start();
