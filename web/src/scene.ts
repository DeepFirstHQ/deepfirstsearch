import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  IcosahedronGeometry,
  LineBasicMaterial,
  LineSegments,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Timer,
  WebGLRenderer,
  WireframeGeometry,
} from "three";

// The hero "core": a cloud of exposed data points that assembles into a sphere
// and then seals itself inside a shield as the user scrolls.

const vertex = /* glsl */ `
  uniform float uTime;
  uniform float uAssemble;
  uniform float uSeal;
  uniform float uSize;
  uniform float uPixelRatio;
  attribute vec3 aScatter;
  attribute float aSeed;
  varying float vSeal;
  varying float vSeed;

  void main() {
    float t = clamp(uAssemble * 1.35 - aSeed * 0.35, 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    vec3 p = mix(aScatter, position, t);

    // Loose particles drift; sealed ones settle into a slow breathing shell.
    float drift = (1.0 - uSeal) * (0.06 + (1.0 - t) * 0.35);
    p += normalize(position) * sin(uTime * 0.9 + aSeed * 6.2831) * drift;
    p *= mix(1.0, 0.78, uSeal) * (1.0 + sin(uTime * 1.4) * 0.012 * uSeal);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * uPixelRatio * (0.55 + aSeed * 0.9) / -mv.z;
    vSeal = uSeal;
    vSeed = aSeed;
  }
`;

const fragment = /* glsl */ `
  uniform float uOpacity;
  varying float vSeal;
  varying float vSeed;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.0, d);
    vec3 white = vec3(0.96, 0.96, 0.97);
    vec3 blue = vec3(0.58, 0.72, 1.0);
    vec3 violet = vec3(0.73, 0.64, 1.0);
    vec3 sealed = mix(blue, violet, vSeed);
    vec3 col = mix(white, sealed, smoothstep(0.0, 1.0, vSeal + vSeed * 0.25));
    gl_FragColor = vec4(col, a * uOpacity * (0.45 + vSeed * 0.55));
  }
`;

export type Core = {
  setProgress(p: number): void;
  setIntro(v: number): void;
  setActive(active: boolean): void;
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const range = (p: number, a: number, b: number) => clamp01((p - a) / (b - a));

export function createCore(canvas: HTMLCanvasElement, reducedMotion: boolean): Core | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: "high-performance" });
  } catch {
    canvas.hidden = true;
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new Scene();
  const camera = new PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.z = 9.5;

  const group = new Group();
  scene.add(group);

  const count = window.innerWidth < 720 ? 4500 : 9000;
  const sphere = new Float32Array(count * 3);
  const scatter = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const R = 2;

  for (let i = 0; i < count; i++) {
    // Fibonacci sphere for an even surface.
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = golden * i;
    sphere.set([Math.cos(th) * r * R, y * R, Math.sin(th) * r * R], i * 3);

    // Scattered cloud: random directions at a wide, uneven radius.
    const u = Math.random() * 2 - 1;
    const phi = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const dist = 3 + Math.pow(Math.random(), 0.6) * 6;
    scatter.set([Math.cos(phi) * s * dist * 1.6, u * dist, Math.sin(phi) * s * dist], i * 3);
    seeds[i] = Math.random();
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(sphere, 3));
  geometry.setAttribute("aScatter", new BufferAttribute(scatter, 3));
  geometry.setAttribute("aSeed", new BufferAttribute(seeds, 1));

  const uniforms = {
    uTime: { value: 0 },
    uAssemble: { value: 0 },
    uSeal: { value: 0 },
    uSize: { value: 38 },
    uPixelRatio: { value: renderer.getPixelRatio() },
    uOpacity: { value: 1 },
  };
  const material = new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  group.add(new Points(geometry, material));

  // The shield: a faint geodesic cage that closes around the core.
  const shellMaterial = new LineBasicMaterial({ color: 0x94b8ff, transparent: true, opacity: 0, depthWrite: false });
  const shell = new LineSegments(new WireframeGeometry(new IcosahedronGeometry(2.05, 2)), shellMaterial);
  group.add(shell);

  let intro = 0;
  let progress = 0;
  let active = true;
  let raf = 0;
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  const timer = new Timer();

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Keep the sphere framed on narrow screens.
    camera.position.z = w / h < 0.8 ? 13 : 9.5;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  window.addEventListener(
    "pointermove",
    (e) => {
      pointer.tx = (e.clientX / window.innerWidth - 0.5) * 2;
      pointer.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    },
    { passive: true },
  );

  const apply = (time: number) => {
    const p = progress;
    uniforms.uTime.value = time;
    uniforms.uAssemble.value = 0.5 * intro + 0.5 * range(p, 0, 0.45);
    uniforms.uSeal.value = range(p, 0.35, 0.8);
    shellMaterial.opacity = 0.22 * range(p, 0.5, 0.85);
    uniforms.uOpacity.value = 1 - 0.35 * range(p, 0.85, 1);

    pointer.x += (pointer.tx - pointer.x) * 0.05;
    pointer.y += (pointer.ty - pointer.y) * 0.05;
    group.rotation.y = time * 0.06 + p * Math.PI * 1.4 + pointer.x * 0.25;
    group.rotation.x = 0.25 + p * 0.5 + pointer.y * 0.15;
    shell.rotation.y = -time * 0.08;
    group.scale.setScalar(1 + range(p, 0, 0.5) * 0.12);
    renderer.render(scene, camera);
  };

  const loop = () => {
    raf = requestAnimationFrame(loop);
    timer.update();
    apply(timer.getElapsed());
  };

  if (reducedMotion) {
    intro = 1;
    progress = 0.7;
    apply(0);
  } else {
    loop();
  }

  return {
    setProgress(p) {
      progress = p;
      if (reducedMotion) apply(0);
    },
    setIntro(v) {
      intro = v;
    },
    setActive(next) {
      if (reducedMotion || next === active) return;
      active = next;
      if (active) loop();
      else cancelAnimationFrame(raf);
    },
  };
}
