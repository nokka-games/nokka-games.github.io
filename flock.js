// A small flock of paper birds ("nokka" = beak) drifting behind the page.
// Boids: separation, alignment, cohesion. The cursor gently draws them in;
// a click or tap scatters them.
import * as THREE from "three";

const canvas = document.getElementById("sky");
const hint = document.getElementById("hint");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const darkQuery = matchMedia("(prefers-color-scheme: dark)");

const SETTINGS = {
  perception: 7,
  separation: 2.6,
  wSeparation: 26,
  wAlignment: 2.2,
  wCohesion: 0.9,
  minSpeed: 7,
  maxSpeed: 15,
  edgePush: 3,
  attractRadius: 26,
  attract: 14,
  scatterRadius: 32,
  scatter: 260,
  depth: 10,
  scale: 0.8,
};

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function birdGeometry() {
  // Forward is +Z (Object3D.lookAt points +Z at the target).
  const nose = [0, 0, 1.3];
  const tail = [0, 0.05, -0.9];
  const keel = [0, -0.32, -0.1];
  const left = [-1.25, 0.05, -0.45];
  const right = [1.25, 0.05, -0.45];
  const tris = [
    [nose, left, tail],
    [nose, tail, right],
    [nose, keel, tail],
  ];
  const positions = [];
  const wing = [];
  for (const tri of tris) {
    for (const v of tri) {
      positions.push(...v);
      wing.push(v === left || v === right ? 1 : 0);
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
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    canvas.remove();
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 400);
  camera.position.z = 70;

  scene.add(new THREE.AmbientLight(0xffffff, 2.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-3, 6, 5);
  scene.add(sun);

  const count = innerWidth < 700 ? 70 : 140;
  const geometry = birdGeometry();
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) phase[i] = Math.random() * Math.PI * 2;
  const phaseAttr = new THREE.InstancedBufferAttribute(phase, 1);
  geometry.setAttribute("aPhase", phaseAttr);

  const uniforms = { uFlap: { value: 0.55 } };
  const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, flatShading: true });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFlap = uniforms.uFlap;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "attribute float aWing;\nattribute float aPhase;\nuniform float uFlap;\n#include <common>")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\ntransformed.y += sin(aPhase) * uFlap * aWing;\ntransformed.x *= 1.0 - 0.18 * aWing * abs(sin(aPhase));"
      );
  };

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const accentEvery = 17;
  const applyColors = () => {
    const base = new THREE.Color(cssVar("--bird"));
    const accent = new THREE.Color(cssVar("--accent"));
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      if (i % accentEvery === 0) c.copy(accent);
      else c.copy(base).offsetHSL(0, 0, (Math.random() - 0.5) * 0.06);
      mesh.setColorAt(i, c);
    }
    mesh.instanceColor.needsUpdate = true;
  };
  applyColors();

  const bounds = new THREE.Vector3();
  const resize = () => {
    const w = innerWidth;
    const h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const halfH = camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    bounds.set(halfH * camera.aspect * 0.92, halfH * 0.88, SETTINGS.depth);
  };
  resize();

  const pos = [];
  const vel = [];
  for (let i = 0; i < count; i++) {
    pos.push(new THREE.Vector3(
      THREE.MathUtils.randFloatSpread(bounds.x * 2),
      THREE.MathUtils.randFloatSpread(bounds.y * 2),
      THREE.MathUtils.randFloatSpread(bounds.z * 2)
    ));
    const a = Math.random() * Math.PI * 2;
    vel.push(new THREE.Vector3(Math.cos(a), Math.sin(a) * 0.4, Math.random() - 0.5).setLength(SETTINGS.minSpeed + 2));
  }

  const pointer = { world: new THREE.Vector3(), active: false };
  const scatter = { at: new THREE.Vector3(), t: 0 };
  const ndc = new THREE.Vector3();
  const toWorld = (e, out) => {
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1, 0.5).unproject(camera);
    ndc.sub(camera.position).normalize();
    return out.copy(camera.position).addScaledVector(ndc, -camera.position.z / ndc.z);
  };
  addEventListener("pointermove", (e) => {
    toWorld(e, pointer.world);
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
  const dummy = new THREE.Object3D();
  dummy.scale.setScalar(SETTINGS.scale);
  const S = SETTINGS;

  const step = (dt) => {
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

      // Soft walls.
      if (p.x > bounds.x) acc.x -= (p.x - bounds.x) * S.edgePush;
      if (p.x < -bounds.x) acc.x -= (p.x + bounds.x) * S.edgePush;
      if (p.y > bounds.y) acc.y -= (p.y - bounds.y) * S.edgePush;
      if (p.y < -bounds.y) acc.y -= (p.y + bounds.y) * S.edgePush;
      if (p.z > bounds.z) acc.z -= (p.z - bounds.z) * S.edgePush;
      if (p.z < -bounds.z) acc.z -= (p.z + bounds.z) * S.edgePush;

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

      // Flap faster when pushing hard, glide when cruising.
      phase[i] += dt * (7 + Math.min(acc.length(), 40) * 0.35);
    }
    scatter.t = Math.max(0, scatter.t - dt * 1.6);
  };

  const sync = () => {
    for (let i = 0; i < count; i++) {
      dummy.position.copy(pos[i]);
      dummy.lookAt(tmp.copy(pos[i]).add(vel[i]));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    phaseAttr.needsUpdate = true;
  };

  const show = () => requestAnimationFrame(() => canvas.classList.add("on"));

  darkQuery.addEventListener("change", applyColors);

  // Let the flock form before the first frame.
  for (let k = 0; k < 240; k++) step(1 / 60);

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
  if (hint) hint.textContent = matchMedia("(hover: hover)").matches ? "click to scatter" : "tap to scatter";

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    step(Math.min(clock.getDelta(), 1 / 30));
    sync();
    renderer.render(scene, camera);
  });
  show();
}

start();
