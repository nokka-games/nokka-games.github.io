// A murmuration of paper birds ("nokka" = beak) behind the hero.
// Each bird's position and velocity live in float textures and are stepped on
// the GPU: a curl-noise flow field gives the swirling, rolling motion of a real
// murmuration. Every so often the flock settles into the Nokka mark, drawn
// stroke by stroke, holds it for a moment, then peels away again. A handful of
// accent birds never join the mark and keep circling it. The cursor parts the
// birds; a click or tap scatters them.
import * as THREE from "three";
import { GPUComputationRenderer } from "three/addons/misc/GPUComputationRenderer.js";

const canvas = document.getElementById("sky");
const hero = canvas.closest(".hero") ?? document.body;
const hint = document.getElementById("hint");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const darkQuery = matchMedia("(prefers-color-scheme: dark)");

const MARK_PATH = "M21.5 73V33.4A12.4 12.4 0 0 1 42.66 24.63L60.19 42.16A2.75 2.75 0 0 1 56.76 46.42L39.67 35.37A4 4 0 0 0 33.5 38.73V73A6 6 0 0 1 21.5 73Z";

const SETTINGS = {
  cameraZ: 70,
  fov: 42,
  parallax: 3.5,
  accentEvery: 41,
  depth: 3, // z spread of the formed mark
  firstForm: 3.5, // seconds before the first formation
  hold: 6.5, // seconds the mark holds once complete
  roam: 8, // seconds of free flight between formations
  formRate: 0.42, // uForm per second while assembling
  releaseRate: 0.9,
};

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const srgb = (hex) => {
  const out = { r: 0, g: 0, b: 0 };
  new THREE.Color(hex).getRGB(out, THREE.SRGBColorSpace);
  return new THREE.Vector3(out.r, out.g, out.b);
};

function birdGeometry() {
  // Forward is +Z. Each wing folds once: the inner panel lifts a little, the tip a lot.
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
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("aWing", new THREE.Float32BufferAttribute(wing, 1));
  return g;
}

// Points spread evenly over the mark, centred on the origin, 1 unit tall.
// Each point carries an order (0..1) so the mark assembles like a pen stroke.
function sampleMark(count) {
  const S = 320;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d", { willReadFrequently: true });
  const k = S / 58;
  g.setTransform(k, 0, 0, k, -21.5 * k + (S - 57 * k) / 2, -21 * k);
  const path = new Path2D(MARK_PATH);
  g.fill(path);
  g.transform(-1, 0, 0, -1, 100, 100);
  g.fill(path);
  const { data } = g.getImageData(0, 0, S, S);
  const inside = (x, y) => data[(y * S + x) * 4 + 3] > 127;

  let area = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 127) area++;
  const step = Math.sqrt(area / count) * 0.97;
  const pts = [];
  for (let y = step / 2; y < S; y += step) {
    for (let x = step / 2; x < S; x += step) {
      const jx = Math.min(S - 1, Math.max(0, Math.round(x + (Math.random() - 0.5) * step * 0.7)));
      const jy = Math.min(S - 1, Math.max(0, Math.round(y + (Math.random() - 0.5) * step * 0.7)));
      if (inside(jx, jy)) pts.push([jx, jy]);
    }
  }
  for (let i = pts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pts[i], pts[j]] = [pts[j], pts[i]];
  }
  while (pts.length < count) pts.push(pts[Math.floor(Math.random() * pts.length)]);
  pts.length = count;

  const h = 58 * k;
  return pts.map(([x, y]) => {
    const nx = (x - S / 2) / h;
    const ny = -(y - S / 2) / h;
    // Bottom-left to top-right, with a little grain so the stroke edge is soft.
    const order = THREE.MathUtils.clamp((nx * 0.9 + ny * 1.1) / 1.6 + 0.5 + (Math.random() - 0.5) * 0.12, 0, 1);
    return [nx, ny, order];
  });
}

const NOISE = /* glsl */ `
vec4 permute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0 / 7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
vec3 snoise3(vec3 p) {
  return vec3(snoise(p), snoise(p + vec3(31.4, -17.2, 9.7)), snoise(p + vec3(-23.9, 41.3, -11.6)));
}
vec3 curl(vec3 p) {
  const float e = 0.1;
  vec3 dx = vec3(e, 0.0, 0.0), dy = vec3(0.0, e, 0.0), dz = vec3(0.0, 0.0, e);
  vec3 px0 = snoise3(p - dx), px1 = snoise3(p + dx);
  vec3 py0 = snoise3(p - dy), py1 = snoise3(p + dy);
  vec3 pz0 = snoise3(p - dz), pz1 = snoise3(p + dz);
  float x = (py1.z - py0.z) - (pz1.y - pz0.y);
  float y = (pz1.x - pz0.x) - (px1.z - px0.z);
  float z = (px1.y - px0.y) - (py1.x - py0.x);
  return vec3(x, y, z) / (2.0 * e);
}
`;

const POSITION_SHADER = /* glsl */ `
uniform float uDelta;
void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 p = texture2D(texturePosition, uv);
  vec3 v = texture2D(textureVelocity, uv).xyz;
  gl_FragColor = vec4(p.xyz + v * uDelta, p.w);
}
`;

const VELOCITY_SHADER = /* glsl */ `
uniform float uTime;
uniform float uDelta;
uniform float uForm;
uniform float uScatter;
uniform vec3 uGoal;
uniform vec3 uBounds;
uniform vec4 uKeepOut;
uniform vec3 uPointer;
uniform float uPointerOn;
uniform vec3 uScatterAt;
uniform sampler2D tTarget;
${NOISE}
void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 P = texture2D(texturePosition, uv);
  vec3 p = P.xyz;
  float seed = P.w;
  vec3 v = texture2D(textureVelocity, uv).xyz;
  vec4 target = texture2D(tTarget, uv);

  // Free flight: ride the flow field, stay loosely around a wandering goal.
  vec3 flow = curl(p * 0.04 + vec3(0.0, 0.0, uTime * 0.07)) * 7.0;
  flow += vec3(-2.4, 0.6, 0.0); // a prevailing breeze keeps the stream moving
  vec3 rel = (p - uGoal) / uBounds;
  float r = length(rel);
  flow -= normalize(rel + 1e-4) * smoothstep(0.55, 1.25, r) * 30.0;
  if (p.x > uKeepOut.x && p.x < uKeepOut.z && p.y > uKeepOut.y && p.y < uKeepOut.w) {
    flow.y += (p.y > (uKeepOut.y + uKeepOut.w) * 0.5 ? 1.0 : -1.0) * 18.0;
  }

  // Formation: birds join in pen-stroke order; accent birds (order < 0) never do.
  float w = target.w < 0.0 ? 0.0 : smoothstep(target.w * 0.6, target.w * 0.6 + 0.4, uForm);
  vec3 toT = target.xyz - p;
  float d = length(toT);
  vec3 hover = vec3(sin(uTime * 1.7 + seed * 40.0), cos(uTime * 1.3 + seed * 23.0), sin(uTime * 1.1 + seed * 11.0)) * 0.3;
  vec3 seek = toT * 3.2 / (1.0 + d * 0.03) + hover;

  vec3 desired = mix(flow, seek, w);
  v += (desired - v) * (1.0 - exp(-uDelta * mix(1.6, 5.5, w)));

  vec3 dp = p - uPointer;
  v.xy += normalize(dp.xy + 1e-4) * uPointerOn * smoothstep(7.0, 0.0, length(dp.xy)) * 70.0 * uDelta;
  vec3 ds = p - uScatterAt;
  v += normalize(ds + 1e-4) * uScatter * smoothstep(34.0, 0.0, length(ds)) * 380.0 * uDelta;

  float s = length(v);
  float maxS = mix(15.0, 42.0, w) * (1.0 + uScatter * 1.5);
  if (s > maxS) v *= maxS / s;
  float minS = 5.0 * (1.0 - w);
  if (s < minS) v *= minS / max(s, 1e-3);
  gl_FragColor = vec4(v, 1.0);
}
`;

const BIRD_VERTEX = /* glsl */ `
attribute float aWing;
attribute vec2 aRef;
attribute vec3 aColor;
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform sampler2D tTarget;
uniform float uTime;
uniform float uForm;
uniform float uScale;
varying vec3 vColor;
varying vec3 vView;
void main() {
  vec4 P = texture2D(tPos, aRef);
  vec3 v = texture2D(tVel, aRef).xyz;
  vec4 tgt = texture2D(tTarget, aRef);
  float seed = P.w;

  // Settled birds turn to face the same way, so the mark reads as one flock.
  float settled = tgt.w < 0.0 ? 0.0 : uForm * (1.0 - smoothstep(0.6, 4.0, length(tgt.xyz - P.xyz)));
  vec3 heading = normalize(v + vec3(0.0, 0.0, 1e-3));
  vec3 fwd = normalize(mix(heading, normalize(vec3(-0.5, 0.25, 0.85)), settled * 0.9));
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up = cross(fwd, right);

  // Flap faster in a hurry, a lazy beat while holding the mark.
  float rate = mix(9.0, 13.0, fract(seed * 3.7)) * mix(1.0, 0.55, settled) + min(length(v), 40.0) * 0.12;
  float s = sin(uTime * rate + seed * 60.0 - aWing * 0.9);
  vec3 lp = position;
  lp.y += s * 0.6 * aWing;
  lp.x *= 1.0 - 0.16 * aWing * abs(s);
  lp *= uScale * mix(0.82, 1.18, fract(seed * 7.31));

  vec3 world = P.xyz + right * lp.x + up * lp.y + fwd * lp.z;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vView = mv.xyz;
  vColor = aColor;
  gl_Position = projectionMatrix * mv;
}
`;

const BIRD_FRAGMENT = /* glsl */ `
uniform vec3 uBg;
uniform vec2 uFog;
varying vec3 vColor;
varying vec3 vView;
void main() {
  vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
  float diff = abs(dot(n, normalize(vec3(-0.35, 0.85, 0.4))));
  vec3 c = vColor * (0.68 + 0.42 * diff);
  float fog = smoothstep(uFog.x, uFog.y, -vView.z);
  gl_FragColor = vec4(mix(c, uBg, fog), 1.0);
}
`;

function start() {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    canvas.remove();
    return;
  }
  if (!renderer.capabilities.isWebGL2) {
    renderer.dispose();
    canvas.remove();
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const S = SETTINGS;
  const small = innerWidth < 760;
  const W = 64;
  const H = small ? 16 : 32;
  const count = W * H;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(S.fov, 1, 1, 400);
  camera.position.z = S.cameraZ;

  // ——— GPU simulation ———
  const gpu = new GPUComputationRenderer(W, H, renderer);
  if (!renderer.extensions.has("EXT_color_buffer_float")) gpu.setDataType(THREE.HalfFloatType);
  const pos0 = gpu.createTexture();
  const vel0 = gpu.createTexture();

  const targetData = new Float32Array(count * 4);
  const targetTex = new THREE.DataTexture(targetData, W, H, THREE.RGBAFormat, THREE.FloatType);
  targetTex.minFilter = targetTex.magFilter = THREE.NearestFilter;

  const posVar = gpu.addVariable("texturePosition", POSITION_SHADER, pos0);
  const velVar = gpu.addVariable("textureVelocity", VELOCITY_SHADER, vel0);
  gpu.setVariableDependencies(posVar, [posVar, velVar]);
  gpu.setVariableDependencies(velVar, [posVar, velVar]);
  posVar.material.uniforms.uDelta = { value: 0 };
  const sim = {
    uTime: { value: Math.random() * 100 },
    uDelta: { value: 0 },
    uForm: { value: 0 },
    uScatter: { value: 0 },
    uGoal: { value: new THREE.Vector3() },
    uBounds: { value: new THREE.Vector3(30, 18, 12) },
    uKeepOut: { value: new THREE.Vector4(1e4, 1e4, -1e4, -1e4) },
    uPointer: { value: new THREE.Vector3(1e4, 1e4, 0) },
    uPointerOn: { value: 0 },
    uScatterAt: { value: new THREE.Vector3() },
    tTarget: { value: targetTex },
  };
  Object.assign(velVar.material.uniforms, sim);
  if (gpu.init()) {
    renderer.dispose();
    canvas.remove();
    return;
  }

  // ——— Birds ———
  const geometry = birdGeometry();
  const ref = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    ref[i * 2] = ((i % W) + 0.5) / W;
    ref[i * 2 + 1] = (Math.floor(i / W) + 0.5) / H;
  }
  geometry.setAttribute("aRef", new THREE.InstancedBufferAttribute(ref, 2));
  const colors = new Float32Array(count * 3);
  const colorAttr = new THREE.InstancedBufferAttribute(colors, 3);
  geometry.setAttribute("aColor", colorAttr);
  geometry.instanceCount = count;

  const material = new THREE.ShaderMaterial({
    vertexShader: BIRD_VERTEX,
    fragmentShader: BIRD_FRAGMENT,
    side: THREE.DoubleSide,
    uniforms: {
      tPos: { value: pos0 },
      tVel: { value: vel0 },
      tTarget: { value: targetTex },
      uTime: sim.uTime,
      uForm: sim.uForm,
      uScale: { value: small ? 0.3 : 0.42 },
      uBg: { value: new THREE.Vector3() },
      uFog: { value: new THREE.Vector2(S.cameraZ - 4, S.cameraZ + 34) },
    },
  });
  const birds = new THREE.Mesh(geometry, material);
  birds.frustumCulled = false;
  scene.add(birds);

  const isAccent = (i) => i % S.accentEvery === 0;
  const shade = Array.from({ length: count }, () => (Math.random() - 0.5) * 0.07);
  const applyTheme = () => {
    const base = new THREE.Color(cssVar("--bird"));
    const accent = new THREE.Color(cssVar("--accent"));
    const c = new THREE.Color();
    const out = { r: 0, g: 0, b: 0 };
    for (let i = 0; i < count; i++) {
      if (isAccent(i)) c.copy(accent);
      else c.copy(base).offsetHSL(0, 0, shade[i]);
      c.getRGB(out, THREE.SRGBColorSpace);
      colors.set([out.r, out.g, out.b], i * 3);
    }
    colorAttr.needsUpdate = true;
    material.uniforms.uBg.value.copy(srgb(cssVar("--bg")));
  };
  applyTheme();
  darkQuery.addEventListener("change", () => {
    applyTheme();
    if (reduceMotion) renderer.render(scene, camera);
  });

  // ——— Layout: where the mark forms and what the flock keeps clear of ———
  const markPoints = sampleMark(count);
  const halfView = new THREE.Vector2();
  const mark = { center: new THREE.Vector3(), size: 30 };
  // With ink set, measure the text itself: block boxes run wider than their lines.
  const range = document.createRange();
  const inkRect = (el) => {
    range.selectNodeContents(el);
    return range.getBoundingClientRect();
  };
  const unionRect = (els, measure = (el) => el.getBoundingClientRect()) => {
    const rs = els.map(measure).filter((r) => r.width && r.height);
    if (!rs.length) return null;
    return {
      left: Math.min(...rs.map((r) => r.left)),
      right: Math.max(...rs.map((r) => r.right)),
      top: Math.min(...rs.map((r) => r.top)),
      bottom: Math.max(...rs.map((r) => r.bottom)),
    };
  };
  const copyEls = [...hero.querySelectorAll(".lede, .actions > *")];
  // Measure the buttons, not their full-width row.
  const textEls = [...hero.querySelectorAll(".eyebrow, h1, .lede, .actions > *")];
  const header = document.querySelector(".top");

  const layout = () => {
    const c = canvas.getBoundingClientRect();
    if (!c.width || !c.height) return;
    const text = unionRect(textEls, inkRect);
    const k = (2 * halfView.y) / c.height; // world units per CSS pixel at z = 0
    const toX = (px) => (px - c.left - c.width / 2) * k;
    const toY = (py) => (c.height / 2 - (py - c.top)) * k;

    // Prefer the empty space beside the copy; on narrow screens, the space above it.
    let cx, cy, sizePx;
    const sideW = text ? c.right - text.right : c.width;
    if (text && sideW > c.width * 0.24) {
      cx = (text.right + c.right) / 2;
      cy = c.top + c.height * 0.5;
      sizePx = Math.min(sideW * 0.78, c.height * 0.56);
    } else {
      const top = header ? header.getBoundingClientRect().bottom : c.top;
      const bottom = text ? text.top : c.bottom;
      cx = c.left + c.width / 2;
      cy = (top + bottom) / 2;
      sizePx = Math.min(Math.max(bottom - top, 120) * 0.78, c.width * 0.62);
    }
    mark.center.set(toX(cx), toY(cy), 0);
    mark.size = sizePx * k;

    for (let i = 0; i < count; i++) {
      const [nx, ny, order] = markPoints[i];
      targetData[i * 4] = mark.center.x + nx * mark.size;
      targetData[i * 4 + 1] = mark.center.y + ny * mark.size;
      targetData[i * 4 + 2] = (Math.random() - 0.5) * S.depth;
      targetData[i * 4 + 3] = isAccent(i) ? -1 : order;
    }
    targetTex.needsUpdate = true;

    sim.uBounds.value.set(halfView.x * 0.62, halfView.y * 0.55, 12);
    const copy = unionRect(copyEls);
    if (copy) sim.uKeepOut.value.set(toX(copy.left) - 1.5, toY(copy.bottom) - 1.5, toX(copy.right) + 1.5, toY(copy.top) + 1.5);
  };

  const resize = () => {
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    halfView.y = S.cameraZ * Math.tan(THREE.MathUtils.degToRad(S.fov / 2));
    halfView.x = halfView.y * camera.aspect;
    layout();
  };
  resize();
  document.fonts?.ready.then(layout);
  setTimeout(layout, 1500);

  // Start spread loosely across the open side of the hero.
  const p0 = pos0.image.data;
  const v0 = vel0.image.data;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random());
    p0[i * 4] = mark.center.x * 0.5 + Math.cos(a) * r * halfView.x * 0.9;
    p0[i * 4 + 1] = Math.sin(a) * r * halfView.y * 0.8;
    p0[i * 4 + 2] = (Math.random() - 0.5) * 20;
    p0[i * 4 + 3] = Math.random();
    v0[i * 4] = -6 + Math.random() * 2;
    v0[i * 4 + 1] = (Math.random() - 0.5) * 2;
    v0[i * 4 + 2] = (Math.random() - 0.5) * 2;
  }

  const show = () => requestAnimationFrame(() => canvas.classList.add("on"));

  if (reduceMotion) {
    // A still flock, already holding the mark, with the accent birds around it.
    const settle = () => {
      for (let i = 0; i < count; i++) {
        p0[i * 4] = targetData[i * 4];
        p0[i * 4 + 1] = targetData[i * 4 + 1];
        p0[i * 4 + 2] = targetData[i * 4 + 2];
        if (isAccent(i)) {
          const a = Math.random() * Math.PI * 2;
          p0[i * 4] = mark.center.x + Math.cos(a) * mark.size * 0.8;
          p0[i * 4 + 1] = mark.center.y + Math.sin(a) * mark.size * 0.6;
        }
      }
      pos0.needsUpdate = true;
      renderer.render(scene, camera);
    };
    sim.uForm.value = 1;
    settle();
    document.fonts?.ready.then(() => { layout(); settle(); });
    addEventListener("resize", () => { resize(); settle(); });
    show();
    return;
  }

  // gpu.init() copied the (then empty) start textures; upload and copy the filled ones.
  pos0.needsUpdate = vel0.needsUpdate = true;
  gpu.renderTexture(pos0, gpu.getCurrentRenderTarget(posVar));
  gpu.renderTexture(pos0, gpu.getAlternateRenderTarget(posVar));
  gpu.renderTexture(vel0, gpu.getCurrentRenderTarget(velVar));
  gpu.renderTexture(vel0, gpu.getAlternateRenderTarget(velVar));

  // ——— Input ———
  const pointer = { ndc: new THREE.Vector2(), active: false };
  const ndc = new THREE.Vector2();
  const ray = new THREE.Vector3();
  const toNdc = (e, out) => {
    const c = canvas.getBoundingClientRect();
    return out.set(((e.clientX - c.left) / c.width) * 2 - 1, -((e.clientY - c.top) / c.height) * 2 + 1);
  };
  const toWorld = (e, out) => {
    toNdc(e, ndc);
    ray.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(camera.position).normalize();
    return out.copy(camera.position).addScaledVector(ray, -camera.position.z / ray.z);
  };

  // ——— Choreography: roam, assemble the mark, hold, release ———
  const cycle = { formTarget: 0, timer: S.firstForm, scatter: 0 };
  const release = (roam) => {
    cycle.formTarget = 0;
    cycle.timer = roam;
  };

  addEventListener("pointermove", (e) => {
    toWorld(e, sim.uPointer.value);
    toNdc(e, pointer.ndc);
    pointer.active = e.pointerType === "mouse" && Math.abs(pointer.ndc.y) <= 1;
  });
  hero.addEventListener("pointerdown", (e) => {
    toWorld(e, sim.uScatterAt.value);
    cycle.scatter = 1;
    release(S.roam * 0.6);
  });
  document.addEventListener("pointerleave", () => (pointer.active = false));
  addEventListener("blur", () => (pointer.active = false));

  const step = (dt) => {
    const t = (sim.uTime.value += dt);

    cycle.timer -= dt;
    if (cycle.formTarget === 0 && cycle.timer <= 0) {
      cycle.formTarget = 1;
      cycle.timer = Infinity;
    } else if (cycle.formTarget === 1 && cycle.timer === Infinity && sim.uForm.value >= 1) {
      cycle.timer = S.hold;
    } else if (cycle.formTarget === 1 && cycle.timer <= 0) {
      release(S.roam);
    }
    const f = sim.uForm.value;
    sim.uForm.value = cycle.formTarget ? Math.min(1, f + dt * S.formRate) : Math.max(0, f - dt * S.releaseRate);

    // The free flock roams across the open side of the hero.
    sim.uGoal.value.set(
      mark.center.x * 0.55 + Math.sin(t * 0.09) * halfView.x * 0.35,
      Math.sin(t * 0.13 + 1.3) * halfView.y * 0.3,
      -4 + Math.sin(t * 0.05) * 5
    );

    cycle.scatter = Math.max(0, cycle.scatter - dt * 1.4);
    sim.uScatter.value = cycle.scatter;
    sim.uPointerOn.value += ((pointer.active ? 1 : 0) - sim.uPointerOn.value) * (1 - Math.exp(-dt * 6));
    sim.uDelta.value = dt;
    posVar.material.uniforms.uDelta.value = dt;

    gpu.compute();
    material.uniforms.tPos.value = gpu.getCurrentRenderTarget(posVar).texture;
    material.uniforms.tVel.value = gpu.getCurrentRenderTarget(velVar).texture;
  };

  const moveCamera = (dt) => {
    const k = 1 - Math.exp(-dt * 2);
    const tx = pointer.active ? pointer.ndc.x * S.parallax : 0;
    const ty = pointer.active ? pointer.ndc.y * S.parallax * 0.6 : 0;
    camera.position.x += (tx - camera.position.x) * k;
    camera.position.y += (ty - camera.position.y) * k;
    camera.lookAt(0, 0, 0);
  };

  addEventListener("resize", resize);
  new ResizeObserver(resize).observe(canvas);
  if (hint) hint.textContent = matchMedia("(hover: hover)").matches ? "click to scatter" : "tap to scatter";

  // Let the stream form before the first frame.
  for (let k = 0; k < 90; k++) step(1 / 60);
  cycle.timer = S.firstForm;

  const clock = new THREE.Clock();
  const frame = () => {
    const dt = Math.min(clock.getDelta(), 1 / 30);
    step(dt);
    moveCamera(dt);
    renderer.render(scene, camera);
  };
  // Only fly while the hero is on screen.
  new IntersectionObserver(([e]) => {
    clock.getDelta();
    renderer.setAnimationLoop(e.isIntersecting ? frame : null);
  }).observe(canvas);
  show();
}

start();
