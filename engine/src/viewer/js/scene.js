// three.js world view: section meshes from the mesh worker, Minecraft-style lighting (sun +
// hemisphere + baked AO / sky / block light), sky dome, fog, overlays, camera control.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SECTION } from './voxels.js';

const TIME_PRESETS = {
  day: {
    sunDir: [0.42, 0.82, 0.38], sun: 0xfff1dc, sunI: 2.1, hemiSky: 0xc4dcff, hemiGround: 0x75644c, hemiI: 1.15,
    top: 0x2a63c9, horizon: 0x8dbaf0, bottom: 0xc3d6ea, fog: 0xa7c6ec, sunDisc: 0xfff6e0, exposure: 1.0,
    block: 0xffb466, blockI: 0.35, cave: 0.12, emissive: 0.55, stars: 0, glow: 0x8af5ff,
  },
  sunset: {
    sunDir: [0.86, 0.3, 0.4], sun: 0xffad70, sunI: 2.0, hemiSky: 0xf7b293, hemiGround: 0x4a3a52, hemiI: 1.15,
    top: 0x283b78, horizon: 0xff9659, bottom: 0x55395a, fog: 0xd98a6c, sunDisc: 0xffc58a, exposure: 1.05,
    block: 0xffae66, blockI: 0.75, cave: 0.12, emissive: 0.85, stars: 0.12, glow: 0xffe08a,
  },
  night: {
    sunDir: [-0.38, 0.72, -0.42], sun: 0x9fb6ff, sunI: 0.42, hemiSky: 0x34497d, hemiGround: 0x0d1120, hemiI: 0.6,
    top: 0x03060f, horizon: 0x13223f, bottom: 0x070a12, fog: 0x0e1a31, sunDisc: 0xdfe8ff, exposure: 1.15,
    block: 0xffa850, blockI: 1.65, cave: 0.07, emissive: 1.35, stars: 1, glow: 0x9cf0ff,
  },
};

const VERT_PARS = /* glsl */ `
attribute vec4 aLight;
attribute float aBorn;
uniform float uTime;
uniform float uPop;
varying vec3 vMcLight;
varying float vMcGlow;
`;
const VERT_BEGIN = /* glsl */ `
#include <begin_vertex>
float mcAge = uTime - aBorn;
float mcK = clamp(mcAge / 0.55, 0.0, 1.0);
bool mcAnim = aBorn > -1000.0 && uPop > 0.5;
vMcGlow = mcAnim ? (1.0 - mcK) : 0.0;
if (mcAnim) {
  float e = 1.0 - pow(1.0 - mcK, 3.0);
  transformed.y -= (1.0 - e) * 0.9;
}
vMcLight = aLight.xyz;
`;
const VERT_PROJECT = /* glsl */ `
#include <project_vertex>
if (mcAnim && mcAge < 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
`;
const FRAG_PARS = /* glsl */ `
uniform vec3 uBlockLight;
uniform float uCave;
uniform vec3 uGlow;
uniform float uEmissive;
varying vec3 vMcLight;
varying float vMcGlow;
`;
const FRAG_MAP = /* glsl */ `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = vMapUv.x < 0.0 ? vec4(1.0) : texture2D( map, vMapUv );
  diffuseColor *= sampledDiffuseColor;
#endif
`;
const FRAG_LIGHT = /* glsl */ `
float mcSky = vMcLight.x;
float mcSkyF = mcSky * mcSky * (3.0 - 2.0 * mcSky);
reflectedLight.directDiffuse *= mcSkyF;
reflectedLight.indirectDiffuse *= mix(uCave, 1.0, mcSkyF);
totalEmissiveRadiance += diffuseColor.rgb * (uBlockLight * pow(vMcLight.y, 1.7) + vec3(vMcLight.z * uEmissive));
totalEmissiveRadiance += uGlow * (vMcGlow * vMcGlow * 1.4);
#include <aomap_fragment>
`;

export class WorldView {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.listeners = new Map();
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: false }));
    this.maxDpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = Math.min(this.maxDpr, 1.5);
    r.setPixelRatio(this.dpr);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = false;
    this.shadowsOn = true;

    const scene = (this.scene = new THREE.Scene());
    scene.fog = new THREE.Fog(0xb4cfee, 120, 420);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    this.camera.position.set(60, 110, 70);

    const c = (this.controls = new OrbitControls(this.camera, canvas));
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.screenSpacePanning = false;
    c.maxPolarAngle = Math.PI * 0.495;
    c.minDistance = 2;
    c.maxDistance = 900;
    c.zoomToCursor = true;
    c.target.set(0, 64, 0);
    c.addEventListener('change', () => this.markDirty());
    c.addEventListener('start', () => this.emit('userCamera'));

    // lights
    this.hemi = new THREE.HemisphereLight(0xc4dcff, 0x75644c, 1.1);
    scene.add(this.hemi);
    const sun = (this.sun = new THREE.DirectionalLight(0xffffff, 2));
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 900;
    scene.add(sun, sun.target);

    // shared uniforms for all block materials
    this.uniforms = {
      uTime: { value: 0 },
      uPop: { value: 1 },
      uBlockLight: { value: new THREE.Color(0xffb466).multiplyScalar(0.35) },
      uCave: { value: 0.12 },
      uGlow: { value: new THREE.Color(0x8af5ff) },
      uEmissive: { value: 0.55 },
    };
    this.white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.white.needsUpdate = true;
    this.white.colorSpace = THREE.SRGBColorSpace;
    this.atlas = this.white;
    this.materials = {
      opaque: this.makeMaterial('opaque'),
      cutout: this.makeMaterial('cutout'),
      translucent: this.makeMaterial('translucent'),
    };

    this.root = new THREE.Group();
    scene.add(this.root);
    this.sections = new Map();
    this.sky = this.makeSky();
    scene.add(this.sky);
    this.stars = this.makeStars();
    scene.add(this.stars);

    this.overlay = new THREE.Group();
    scene.add(this.overlay);
    this.makeOverlays();

    // time of day
    this.timeName = 'day';
    this.timeCur = this.presetValues(TIME_PRESETS.day);
    this.timeFrom = null;
    this.timeT = 1;
    this.applyTime(this.timeCur);

    this.cutY = null;
    this.area = null;
    this.dirty = true;
    this.lastFrame = performance.now();
    this.t0 = performance.now();
    this.tween = null;
    this.follow = { on: false, target: null };
    this.fly = { on: false, keys: new Set(), yaw: 0, pitch: 0, speed: 18 };
    this.shadowDirtyAt = 0;
    this.fpsAcc = { frames: 0, t: 0, fps: 60 };
    this.lastPopAt = -1e9;

    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement ?? canvas);
    this.installFly();
    r.setAnimationLoop(() => this.frame());
  }

  on(ev, cb) {
    let s = this.listeners.get(ev);
    if (!s) this.listeners.set(ev, (s = new Set()));
    s.add(cb);
  }
  emit(ev, data) {
    for (const cb of this.listeners.get(ev) ?? []) cb(data);
  }

  /** seconds since start (time base for pop-in birth times) */
  now() {
    return (performance.now() - this.t0) / 1000;
  }

  markDirty() {
    this.dirty = true;
  }

  // ------------------------------------------------------------------ materials

  makeMaterial(kind) {
    const m = new THREE.MeshLambertMaterial({
      map: this.atlas,
      vertexColors: true,
      transparent: kind === 'translucent',
      depthWrite: kind !== 'translucent',
      alphaTest: kind === 'cutout' ? 0.5 : 0,
      side: THREE.FrontSide,
    });
    if (kind === 'cutout') {
      // overlays (grass sides) are coplanar with the base face
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -2;
    }
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
        .replace('#include <begin_vertex>', VERT_BEGIN)
        .replace('#include <project_vertex>', VERT_PROJECT);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
        .replace('#include <map_fragment>', FRAG_MAP)
        .replace('#include <aomap_fragment>', FRAG_LIGHT);
    };
    m.customProgramCacheKey = () => `mcai-block-${kind}`;
    return m;
  }

  /** set the block atlas (THREE.Texture) or null for flat colors */
  setAtlas(tex) {
    if (tex) {
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
    }
    this.atlas = tex ?? this.white;
    for (const m of Object.values(this.materials)) {
      m.map = this.atlas;
      m.needsUpdate = true;
    }
    this.markDirty();
    this.requestShadow();
  }

  // ------------------------------------------------------------------ sections

  clearSections() {
    for (const s of this.sections.values()) this.disposeSection(s);
    this.sections.clear();
    this.requestShadow();
    this.markDirty();
  }

  disposeSection(s) {
    for (const m of Object.values(s.meshes)) {
      if (!m) continue;
      m.geometry.dispose();
      s.group.remove(m);
    }
    this.root.remove(s.group);
  }

  /** apply a `section` message from the mesh worker */
  setSection(msg) {
    let s = this.sections.get(msg.key);
    const [sx, sy, sz] = msg.sc;
    const empty = !msg.layers.opaque && !msg.layers.cutout && !msg.layers.translucent;
    if (empty) {
      if (s) {
        this.disposeSection(s);
        this.sections.delete(msg.key);
        this.requestShadow();
        this.markDirty();
      }
      return;
    }
    if (!s) {
      const group = new THREE.Group();
      group.position.set(sx * SECTION, sy * SECTION, sz * SECTION);
      group.matrixAutoUpdate = false;
      group.updateMatrix();
      this.root.add(group);
      s = { group, meshes: { opaque: null, cutout: null, translucent: null }, oy: sy * SECTION };
      this.sections.set(msg.key, s);
    }
    for (const kind of ['opaque', 'cutout', 'translucent']) {
      const l = msg.layers[kind];
      const old = s.meshes[kind];
      if (old) {
        old.geometry.dispose();
        s.group.remove(old);
        s.meshes[kind] = null;
      }
      if (!l) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(l.position, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(l.normal, 3, true));
      g.setAttribute('uv', new THREE.BufferAttribute(l.uv, 2));
      g.setAttribute('color', new THREE.BufferAttribute(l.color, 4, true));
      g.setAttribute('aLight', new THREE.BufferAttribute(l.light, 4, true));
      g.setAttribute('aBorn', new THREE.BufferAttribute(l.born, 1));
      g.setIndex(new THREE.BufferAttribute(l.index, 1));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(8, 8, 8), 14.5);
      g.boundingBox = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(17, 17, 17));
      const mesh = new THREE.Mesh(g, this.materials[kind]);
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = kind !== 'translucent';
      mesh.receiveShadow = true;
      if (kind === 'translucent') mesh.renderOrder = 1;
      s.group.add(mesh);
      s.meshes[kind] = mesh;
      // newly born blocks animate → keep rendering for a while
      for (let i = 0; i < l.born.length; i += 4)
        if (l.born[i] > -1000) {
          this.lastPopAt = Math.max(this.lastPopAt, l.born[i]);
          break;
        }
    }
    s.group.visible = this.cutY === null || s.oy <= this.cutY;
    this.requestShadow();
    this.markDirty();
  }

  /** stats for the HUD */
  meshStats() {
    let tris = 0, draws = 0;
    for (const s of this.sections.values())
      for (const m of Object.values(s.meshes))
        if (m) {
          tris += m.geometry.index.count / 3;
          draws++;
        }
    return { sections: this.sections.size, tris, draws, fps: this.fpsAcc.fps };
  }

  setCut(y) {
    this.cutY = y;
    for (const s of this.sections.values()) s.group.visible = y === null || s.oy <= y;
    this.requestShadow();
    this.markDirty();
  }

  /** world area currently loaded (for fog, shadow camera, sky) */
  setArea(box) {
    this.area = box;
    const cx = (box.min[0] + box.max[0] + 1) / 2, cy = (box.min[1] + box.max[1] + 1) / 2, cz = (box.min[2] + box.max[2] + 1) / 2;
    const half = Math.max(box.max[0] - box.min[0], box.max[2] - box.min[2]) / 2 + 8;
    this.areaCenter = new THREE.Vector3(cx, cy, cz);
    this.areaHalf = half;
    const sc = this.sun.shadow.camera;
    sc.left = -half * 1.15; sc.right = half * 1.15; sc.top = half * 1.15; sc.bottom = -half * 1.15;
    sc.updateProjectionMatrix();
    this.updateSunPosition();
    this.scene.fog.near = half * 1.4;
    this.scene.fog.far = half * 5.5 + 200;
    this.markDirty();
  }

  updateSunPosition() {
    const d = this.timeCur?.sunDir ?? new THREE.Vector3(0.4, 0.8, 0.4);
    const c = this.areaCenter ?? new THREE.Vector3(0, 64, 0);
    this.sun.position.copy(c).addScaledVector(d, 400);
    this.sun.target.position.copy(c);
    this.sun.target.updateMatrixWorld();
    this.requestShadow();
  }

  requestShadow() {
    this.shadowDirtyAt = this.shadowDirtyAt || performance.now();
  }

  setShadows(on) {
    this.shadowsOn = on;
    this.renderer.shadowMap.enabled = on;
    this.sun.castShadow = on;
    for (const m of Object.values(this.materials)) m.needsUpdate = true;
    this.requestShadow();
    this.markDirty();
  }

  // ------------------------------------------------------------------ sky & time

  makeSky() {
    const g = new THREE.SphereGeometry(2400, 32, 16);
    const m = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uBottom: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSun: { value: new THREE.Color() }, uNight: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop, uHorizon, uBottom, uSun, uSunDir;
        uniform float uNight;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = h > 0.0 ? mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(uHorizon, uBottom, pow(clamp(-h, 0.0, 1.0), 0.35));
          float s = max(dot(d, normalize(uSunDir)), 0.0);
          float disc = smoothstep(0.9975, 0.9988, s);
          float glow = pow(s, 12.0) * 0.45 + pow(s, 3.0) * 0.12;
          col += uSun * (glow * (1.0 - uNight * 0.6)) + uSun * disc * (uNight > 0.5 ? 0.9 : 2.2);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.renderOrder = -10;
    return mesh;
  }

  makeStars() {
    const n = 1600;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    let seed = 1337;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2;
      const y = Math.abs(u) * 0.95 + 0.05;
      const r = Math.sqrt(1 - y * y);
      pos.set([Math.cos(th) * r * 2000, y * 2000, Math.sin(th) * r * 2000], i * 3);
      size[i] = 1 + rnd() * 2.2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1));
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: { uOpacity: { value: 0 }, uTime: this.uniforms.uTime },
      vertexShader: /* glsl */ `
        attribute float size; uniform float uTime; varying float vTw;
        void main() {
          vTw = 0.65 + 0.35 * sin(uTime * 1.7 + position.x * 0.013 + position.z * 0.021);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
          gl_PointSize = size;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uOpacity; varying float vTw;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.0, length(c));
          gl_FragColor = vec4(vec3(0.85, 0.9, 1.0), a * uOpacity * vTw);
        }`,
    });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    pts.renderOrder = -9;
    return pts;
  }

  presetValues(p) {
    const col = (v) => new THREE.Color(v);
    return {
      sunDir: new THREE.Vector3(...p.sunDir).normalize(), sun: col(p.sun), sunI: p.sunI, hemiSky: col(p.hemiSky), hemiGround: col(p.hemiGround),
      hemiI: p.hemiI, top: col(p.top), horizon: col(p.horizon), bottom: col(p.bottom), fog: col(p.fog), sunDisc: col(p.sunDisc),
      exposure: p.exposure, block: col(p.block), blockI: p.blockI, cave: p.cave, emissive: p.emissive, stars: p.stars, glow: col(p.glow),
      night: p === TIME_PRESETS.night ? 1 : 0,
    };
  }

  setTime(name, animate = true) {
    if (!TIME_PRESETS[name]) return;
    this.timeName = name;
    this.timeTo = this.presetValues(TIME_PRESETS[name]);
    if (!animate) {
      this.timeCur = this.timeTo;
      this.timeT = 1;
      this.applyTime(this.timeCur);
      return;
    }
    this.timeFrom = this.cloneTime(this.timeCur);
    this.timeT = 0;
    this.markDirty();
  }

  cloneTime(v) {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = typeof x === 'number' ? x : x.clone();
    return o;
  }

  lerpTime(a, b, t) {
    const o = {};
    for (const k of Object.keys(b)) {
      if (typeof b[k] === 'number') o[k] = a[k] + (b[k] - a[k]) * t;
      else if (b[k].isColor) o[k] = a[k].clone().lerp(b[k], t);
      else o[k] = a[k].clone().lerp(b[k], t).normalize();
    }
    return o;
  }

  applyTime(v) {
    this.timeCur = v;
    this.sun.color.copy(v.sun);
    this.sun.intensity = v.sunI;
    this.hemi.color.copy(v.hemiSky);
    this.hemi.groundColor.copy(v.hemiGround);
    this.hemi.intensity = v.hemiI;
    const su = this.sky.material.uniforms;
    su.uTop.value.copy(v.top);
    su.uHorizon.value.copy(v.horizon);
    su.uBottom.value.copy(v.bottom);
    su.uSun.value.copy(v.sunDisc);
    su.uSunDir.value.copy(v.sunDir);
    su.uNight.value = v.night;
    this.scene.fog.color.copy(v.fog);
    this.renderer.toneMappingExposure = v.exposure;
    this.uniforms.uBlockLight.value.copy(v.block).multiplyScalar(v.blockI);
    this.uniforms.uCave.value = v.cave;
    this.uniforms.uEmissive.value = v.emissive;
    this.uniforms.uGlow.value.copy(v.glow);
    this.stars.material.uniforms.uOpacity.value = v.stars;
    this.stars.visible = v.stars > 0.01;
    this.updateSunPosition();
  }

  // ------------------------------------------------------------------ overlays

  makeOverlays() {
    const accent = 0x5ee08a;
    // allowed build box (wand preview)
    this.siteBox = this.makeBox(accent, 0.07);
    this.jobBox = this.makeBox(0xf5c84c, 0.035);
    // anchor marker + facing arrow
    const arrow = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.08, 3.2), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.95, depthTest: false }));
    shaft.position.z = -1.6;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.6, 4), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.95, depthTest: false }));
    head.rotation.x = -Math.PI / 2;
    head.rotation.y = Math.PI / 4;
    head.position.z = -3.6;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.8, 32), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false }));
    ring.rotation.x = -Math.PI / 2;
    for (const o of [shaft, head, ring]) o.renderOrder = 20;
    arrow.add(shaft, head, ring);
    arrow.visible = false;
    this.anchorArrow = arrow;
    this.overlay.add(arrow);
    // hover / anchor block outline
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02));
    this.hover = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }));
    this.hover.renderOrder = 21;
    this.hover.visible = false;
    this.overlay.add(this.hover);
    // focus pulse
    this.focusPulse = new THREE.Mesh(new THREE.BoxGeometry(1.08, 1.08, 1.08), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
    this.focusPulse.visible = false;
    this.overlay.add(this.focusPulse);
  }

  makeBox(color, fillOpacity) {
    const g = new THREE.Group();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: fillOpacity, depthWrite: false, side: THREE.DoubleSide }));
    const line = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    fill.renderOrder = 5;
    line.renderOrder = 6;
    g.add(fill, line);
    g.visible = false;
    g.userData = { fill, line, baseOpacity: fillOpacity };
    this.overlay.add(g);
    return g;
  }

  showBox(which, box) {
    const g = which === 'job' ? this.jobBox : this.siteBox;
    if (!box) {
      g.visible = false;
      this.markDirty();
      return;
    }
    const sx = box.max[0] - box.min[0] + 1, sy = box.max[1] - box.min[1] + 1, sz = box.max[2] - box.min[2] + 1;
    g.position.set(box.min[0] + sx / 2, box.min[1] + sy / 2, box.min[2] + sz / 2);
    g.scale.set(sx + 0.04, sy + 0.04, sz + 0.04);
    g.visible = true;
    this.markDirty();
  }

  showAnchor(anchor, facing) {
    if (!anchor) {
      this.anchorArrow.visible = false;
      this.markDirty();
      return;
    }
    const yaw = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 }[facing] ?? 0;
    this.anchorArrow.position.set(anchor[0] + 0.5, anchor[1] + 1.06, anchor[2] + 0.5);
    this.anchorArrow.rotation.set(0, yaw, 0);
    this.anchorArrow.visible = true;
    this.markDirty();
  }

  showHover(pos) {
    if (!pos) this.hover.visible = false;
    else {
      this.hover.position.set(pos[0] + 0.5, pos[1] + 0.5, pos[2] + 0.5);
      this.hover.visible = true;
    }
    this.markDirty();
  }

  pulse(pos) {
    this.focusPulse.position.set(pos[0] + 0.5, pos[1] + 0.5, pos[2] + 0.5);
    this.focusPulse.visible = true;
    this.focusPulseT = 0;
  }

  // ------------------------------------------------------------------ camera

  /** ray (origin, dir arrays) through a client pixel */
  rayAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    return { origin: rc.ray.origin.toArray(), dir: rc.ray.direction.toArray() };
  }

  centerRay() {
    const d = new THREE.Vector3();
    this.camera.getWorldDirection(d);
    return { origin: this.camera.position.toArray(), dir: d.toArray() };
  }

  /** animate the camera to look at `target` from `position` (THREE.Vector3 or arrays) */
  flyTo(target, position, ms = 1200) {
    const tgt = Array.isArray(target) ? new THREE.Vector3(...target) : target.clone();
    const pos = Array.isArray(position) ? new THREE.Vector3(...position) : position.clone();
    if (this.fly.on) this.setFly(false);
    this.tween = { t: 0, ms, fromT: this.controls.target.clone(), fromP: this.camera.position.clone(), toT: tgt, toP: pos };
    this.markDirty();
  }

  /** fly so the whole box is in view (keeps the current viewing direction) */
  frameBox(box, ms = 1300, opts = {}) {
    const c = new THREE.Vector3((box.min[0] + box.max[0] + 1) / 2, (box.min[1] + box.max[1] + 1) / 2, (box.min[2] + box.max[2] + 1) / 2);
    if (opts.groundY !== undefined) c.y = Math.max(box.min[1], Math.min(box.max[1], opts.groundY + (box.max[1] - opts.groundY) * 0.25));
    const size = Math.max(box.max[0] - box.min[0], box.max[2] - box.min[2], (box.max[1] - box.min[1]) * 0.8) + 1;
    let dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1) dir.set(1, 0.8, 1);
    dir.normalize();
    // keep a pleasant elevation
    const el = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    if (el < 0.35 || el > 1.2) {
      const h = Math.hypot(dir.x, dir.z) || 1;
      dir.set((dir.x / h) * Math.cos(0.62), Math.sin(0.62), (dir.z / h) * Math.cos(0.62));
    }
    const dist = Math.max(14, size * (opts.zoom ?? 1.25));
    this.flyTo(c, c.clone().addScaledVector(dir, dist), ms);
  }

  focusBlock(pos) {
    const c = new THREE.Vector3(pos[0] + 0.5, pos[1] + 0.5, pos[2] + 0.5);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = Math.min(this.camera.position.distanceTo(this.controls.target), 22);
    this.flyTo(c, c.clone().addScaledVector(dir, Math.max(8, dist)), 800);
    this.pulse(pos);
  }

  setFollow(on) {
    this.follow.on = on;
    this.markDirty();
  }

  /** follow mode: drift towards this point */
  followPoint(p) {
    this.follow.target = new THREE.Vector3(...p);
    this.markDirty();
  }

  // ------------------------------------------------------------------ fly mode (pointer lock + WASD)

  installFly() {
    const el = this.canvas;
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== el && this.fly.on) this.setFly(false, true);
    });
    el.addEventListener('mousemove', (e) => {
      if (!this.fly.on || document.pointerLockElement !== el) return;
      this.fly.yaw -= e.movementX * 0.0022;
      this.fly.pitch = Math.max(-1.5, Math.min(1.5, this.fly.pitch - e.movementY * 0.0022));
      this.markDirty();
    });
    el.addEventListener('wheel', (e) => {
      if (!this.fly.on) return;
      this.fly.speed = Math.max(3, Math.min(120, this.fly.speed * (e.deltaY > 0 ? 0.85 : 1.18)));
    }, { passive: true });
    window.addEventListener('keydown', (e) => {
      if (this.fly.on) this.fly.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.fly.keys.delete(e.code));
    window.addEventListener('blur', () => this.fly.keys.clear());
  }

  setFly(on, fromUnlock = false) {
    if (on === this.fly.on) return;
    this.fly.on = on;
    this.controls.enabled = !on;
    if (on) {
      this.tween = null;
      const d = new THREE.Vector3();
      this.camera.getWorldDirection(d);
      this.fly.yaw = Math.atan2(-d.x, -d.z);
      this.fly.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
      try {
        this.canvas.requestPointerLock?.();
      } catch {}
    } else {
      this.fly.keys.clear();
      if (!fromUnlock && document.pointerLockElement === this.canvas) document.exitPointerLock?.();
      const d = new THREE.Vector3();
      this.camera.getWorldDirection(d);
      this.controls.target.copy(this.camera.position).addScaledVector(d, 24);
      this.controls.update();
    }
    this.emit('fly', on);
    this.markDirty();
  }

  updateFly(dt) {
    const f = this.fly;
    const cam = this.camera;
    cam.rotation.order = 'YXZ';
    cam.rotation.set(f.pitch, f.yaw, 0);
    const k = f.keys;
    const fwd = new THREE.Vector3(-Math.sin(f.yaw), 0, -Math.cos(f.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const v = new THREE.Vector3();
    if (k.has('KeyW') || k.has('ArrowUp')) v.add(fwd);
    if (k.has('KeyS') || k.has('ArrowDown')) v.sub(fwd);
    if (k.has('KeyD') || k.has('ArrowRight')) v.add(right);
    if (k.has('KeyA') || k.has('ArrowLeft')) v.sub(right);
    if (k.has('Space') || k.has('KeyE')) v.y += 1;
    if (k.has('ShiftLeft') || k.has('ShiftRight') || k.has('KeyQ')) v.y -= 1;
    if (v.lengthSq() > 0) {
      const boost = k.has('ControlLeft') || k.has('AltLeft') ? 3 : 1;
      cam.position.addScaledVector(v.normalize(), f.speed * boost * dt);
      this.markDirty();
    }
  }

  // ------------------------------------------------------------------ frame

  resize() {
    const p = this.canvas.parentElement ?? this.canvas;
    const w = p.clientWidth || window.innerWidth, h = p.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.markDirty();
  }

  frame() {
    const tnow = performance.now();
    const dt = Math.min(0.1, (tnow - this.lastFrame) / 1000);
    this.lastFrame = tnow;
    const now = this.now();
    this.uniforms.uTime.value = now;
    let animating = false;

    if (this.tween) {
      const tw = this.tween;
      tw.t += (dt * 1000) / tw.ms;
      const k = Math.min(1, tw.t);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.controls.target.lerpVectors(tw.fromT, tw.toT, e);
      this.camera.position.lerpVectors(tw.fromP, tw.toP, e);
      if (tw.t >= 1) this.tween = null;
      animating = true;
    } else if (this.follow.on && this.follow.target && !this.fly.on) {
      const tgt = this.controls.target;
      const delta = this.follow.target.clone().sub(tgt);
      if (delta.lengthSq() > 0.01) {
        const step = delta.multiplyScalar(1 - Math.exp(-dt * 1.6));
        tgt.add(step);
        this.camera.position.add(step);
        animating = true;
      }
    }
    if (this.timeT < 1) {
      this.timeT = Math.min(1, this.timeT + dt / 1.6);
      const e = this.timeT * this.timeT * (3 - 2 * this.timeT);
      this.applyTime(this.lerpTime(this.timeFrom, this.timeTo, e));
      animating = true;
    }
    if (this.focusPulse.visible) {
      this.focusPulseT += dt;
      const t = this.focusPulseT / 0.9;
      this.focusPulse.material.opacity = Math.max(0, 0.55 * (1 - t));
      this.focusPulse.scale.setScalar(1 + t * 0.5);
      if (t >= 1) this.focusPulse.visible = false;
      animating = true;
    }
    if (this.fly.on) this.updateFly(dt);
    else if (this.controls.enabled) this.controls.update();
    if (now < this.lastPopAt + 0.7) animating = true;
    if (this.jobBox.visible) {
      this.jobBox.userData.line.material.opacity = 0.55 + 0.35 * Math.sin(now * 2.4);
      animating = true;
    }
    if (this.stars.visible) animating = true;

    // shadows: re-render the shadow map at most every 300 ms while geometry changes
    if (this.shadowsOn && this.shadowDirtyAt && performance.now() - this.shadowDirtyAt > 120) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowDirtyAt = 0;
      this.dirty = true;
    }
    if (!this.dirty && !animating) return;
    this.dirty = false;
    this.sky.position.copy(this.camera.position);
    this.stars.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
    this.emit('frame', { dt });
    // adaptive resolution
    const a = this.fpsAcc;
    a.frames++;
    a.t += dt;
    if (a.t > 2) {
      a.fps = a.frames / a.t;
      if (a.fps < 40 && this.dpr > 1) {
        this.dpr = Math.max(1, this.dpr - 0.25);
        this.resize();
      } else if (a.fps > 58 && this.dpr < Math.min(this.maxDpr, 1.5)) {
        this.dpr = Math.min(this.maxDpr, this.dpr + 0.25);
        this.resize();
      }
      a.frames = 0;
      a.t = 0;
    }
  }

  /** PNG blob of the current view (optionally with a caption watermark) */
  screenshot(caption) {
    this.renderer.render(this.scene, this.camera);
    const src = this.canvas;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const g = out.getContext('2d');
    g.drawImage(src, 0, 0);
    const s = Math.max(1, out.width / 1600);
    g.font = `600 ${Math.round(15 * s)}px -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif`;
    const text = `mcAI${caption ? ' · ' + caption : ''}`;
    const w = g.measureText(text).width;
    const pad = 12 * s;
    g.fillStyle = 'rgba(10,12,18,0.55)';
    const x = out.width - w - pad * 3, y = out.height - 40 * s;
    g.beginPath();
    g.roundRect?.(x, y, w + pad * 2, 28 * s, 8 * s);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.fillText(text, x + pad, y + 19 * s);
    return new Promise((res) => out.toBlob(res, 'image/png'));
  }

  azimuth() {
    return this.fly.on ? -this.fly.yaw : this.controls.getAzimuthalAngle();
  }
}
