// Phase 1 of the living-world scene: terrain-aware, wind-driven instanced grass under the model.
//   WindSystem  - shared wind state (direction, strength, gusts); later systems (leaves, birds, ...) read the same object.
//   Terrain     - seeded height + moisture fields; the area under the model is flattened so its feet sit on the ground.
//   GrassSystem - 5-segment blades, instanced per chunk. Seeded Halton scatter, so any prefix of a chunk's buffer is an evenly
//                 spread subset: distance LOD is just a smaller instanceCount (no second mesh, no popping).
//                 Three species (lawn / meadow / tall wild) chosen from noise patches, thinned by slope and moisture,
//                 colour from moisture + per-blade variation. GPU wind = slow travelling swell + medium sway + per-blade
//                 flutter + gust packets, each species with its own flexibility. The model pushes nearby blades aside.
// Approach adapted from ideas in CK42BB/procedural-grass-threejs, SkyeShark/SeedThree and Leonxlnx/sakura-realm (all MIT);
// no code is copied - they target WebGPU/TSL or three r180 and this viewer runs three r160 on WebGL2.
import * as THREE from 'three';

const mulberry = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const hashStr = s => { let h = 2166136261; for(const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const halton = (i, b) => { let f = 1, r = 0; while(i > 0){ f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export class WindSystem {
  constructor(){ this.dir = new THREE.Vector2(1, 0); this.strength = .45; this.speed = 1; this.gust = .35; this.time = 0; }
  setAngle(deg){ const a = deg * Math.PI / 180; this.dir.set(Math.cos(a), Math.sin(a)); }
}

class Noise {                                                      // seeded value noise (2D) + fbm
  constructor(seed){ const r = mulberry(seed); this.p = new Uint8Array(512); const a = [...Array(256).keys()]; for(let i = 255; i > 0; i--){ const j = (r() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } for(let i = 0; i < 512; i++) this.p[i] = a[i & 255]; }
  v(x, y){ const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf), p = this.p;
    const h = (i, j) => p[p[(i & 255)] + (j & 255)] / 255; return (h(xi, yi) * (1 - u) + h(xi + 1, yi) * u) * (1 - w) + (h(xi, yi + 1) * (1 - u) + h(xi + 1, yi + 1) * u) * w; }
  fbm(x, y){ let s = 0, a = .5; for(let o = 0; o < 4; o++){ s += a * this.v(x, y); x *= 2.03; y *= 2.03; a *= .5; } return s / .9375; }
}

const BLADE_VS = /* glsl */`
uniform float uTime, uWind, uGust, uSpeed, uScale, uHeight, uDry;
uniform vec2 uWindDir;
uniform vec4 uBody;                       // x, z, radius, strength
uniform vec3 uCam, uSun;
uniform float uSpan;
attribute vec3 aOff;                      // base position (ground height included)
attribute vec4 aParam;                    // height, width, phase, yaw
attribute vec4 aMisc;                     // species, hue seed, flexibility, dryness seed
varying float vT, vDist, vBack, vShade;
varying vec3 vCol, vWorld;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
void main(){
  float t = position.y, h = aParam.x * uHeight, w = aParam.y, ph = aParam.z, yaw = aParam.w, species = aMisc.x, flex = aMisc.z;
  float cy = cos(yaw), sy = sin(yaw);
  vec3 p = vec3(cy * position.x * w, t * h, -sy * position.x * w);
  vec2 wp = aOff.xz; float travel = dot(wp, uWindDir);
  float slow   = vnoise(wp * uScale * .6 - uWindDir * uTime * uSpeed * .35);               // large patches of calm / blow
  float swell  = .5 + .5 * sin(travel * uScale * 2.2 - uTime * uSpeed * 1.1 + ph * 6.2831); // medium sway
  float flutter = sin(uTime * (6. + species * 2.5) + ph * 40. + t * 4.);                    // fast, per blade
  float gust   = pow(.5 + .5 * sin(travel * uScale * .5 - uTime * uSpeed * .6), 4.);       // occasional gust packets
  float amp = uWind * (.25 + .75 * slow) * (.55 + .45 * swell) + uGust * gust;
  vec2 d = uWindDir * (amp * flex * t * t * h * .55) + vec2(-uWindDir.y, uWindDir.x) * (flutter * .03 * amp * flex * t * h);
  vec2 bd = aOff.xz - uBody.xy; float br = length(bd);
  float push = (1. - smoothstep(0., uBody.z, br)) * uBody.w;                              // the model parts the grass
  d += (br > .001 ? bd / br : vec2(0.)) * push * h * t * t * 1.3;
  p.xz += d; p.y *= 1. - .5 * push * t; p.y -= dot(d, d) / (2. * h + 1e-4) * t;           // keep blade length roughly constant
  vec3 world = aOff + p; vWorld = world; vT = t; vDist = distance(world, uCam);
  float dry = clamp(uDry + (aMisc.w - .5) * .7, 0., 1.);
  vec3 green = mix(vec3(.13, .29, .06), vec3(.31, .49, .12), aMisc.y), straw = mix(vec3(.47, .41, .19), vec3(.69, .6, .3), aMisc.y);
  vCol = mix(green, straw, dry);
  // the model's cast shadow, approximated on the grass: a tapering strip pointing away from the sun
  vec2 sd = normalize(-uSun.xz + 1e-5), rel = aOff.xz - uBody.xy; float along = dot(rel, sd), across = abs(dot(rel, vec2(-sd.y, sd.x)));
  float L = min(uSpan * 1.0 / max(tan(asin(clamp(uSun.y, .05, 1.))), .2), uSpan * 4.);
  vShade = along > 0. ? (1. - smoothstep(0., uSpan * .26 * (1. + along / L), across)) * (1. - smoothstep(L * .6, L, along)) : 0.;
  vBack = 0.;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.);
}`;
const BLADE_FS = /* glsl */`
uniform vec3 uSun, uSunCol, uAmb, uFogCol, uCam;
uniform float uFogNear, uFogFar;
varying float vT, vDist, vShade; varying vec3 vCol, vWorld;
void main(){
  float ao = mix(.3, 1., smoothstep(0., .65, vT));
  vec3 col = vCol * (.7 + .5 * vT) * ao;
  float diff = .55 + .45 * clamp(uSun.y, 0., 1.);
  col *= uSunCol * diff * (1. - .62 * vShade) + uAmb;
  vec3 V = normalize(uCam - vWorld);
  col += vec3(.42, .55, .08) * pow(max(dot(V, -uSun), 0.), 3.) * vT * .45 * uSunCol;       // backlit translucency
  col = mix(col, uFogCol, smoothstep(uFogNear, uFogFar, vDist));
  gl_FragColor = vec4(col, 1.);
}`;
const SKY_VS = `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`;
const SKY_FS = `uniform vec3 uSun, uSunCol, uHorizon, uZenith; varying vec3 vDir;
void main(){ vec3 d = normalize(vDir); float h = clamp(d.y, 0., 1.);
  vec3 col = mix(uHorizon, uZenith, pow(h, .55)); float s = max(dot(d, uSun), 0.);
  col += uSunCol * (pow(s, 700.) * 3. + pow(s, 10.) * .22); col = mix(col, uHorizon * .96, smoothstep(0., -.18, d.y));
  gl_FragColor = vec4(col, 1.); }`;

export const MEADOW_DEFAULTS = {height: 50, density: 70, wind: 45, speed: 50, gust: 35, dir: 35, dry: 25, rough: 35, sun: 42};

export function createMeadow({scene, span, center, seed = '1', params = {}, wind = new WindSystem()}){
  const P = {...MEADOW_DEFAULTS, ...params}, group = new THREE.Group(), cs = span * .75, K = 3, N = 4200, y0 = center.y;
  const noise = new Noise(hashStr(seed)), moist = new Noise(hashStr(seed + 'm')), patch = new Noise(hashStr(seed + 'p'));
  group.name = 'meadow';

  // ---- terrain
  const amp = () => span * .09 * P.rough / 100;
  const height = (x, z) => { const r = Math.hypot(x - center.x, z - center.z), flat = smooth(span * .3, span * 1.1, r);
    return y0 + (noise.fbm(x / span * .9, z / span * .9) - .5) * 2 * amp() * flat + (noise.fbm(x / span * .25 + 9, z / span * .25) - .4) * span * .5 * smooth(span * 4, span * 9, r); };
  const wet = (x, z) => clamp(moist.fbm(x / span * .7 + 3, z / span * .7 - 5) * 1.5 - .15, 0, 1);
  const T = span * 14, SEG = 160, tg = new THREE.PlaneGeometry(T * 2, T * 2, SEG, SEG); tg.rotateX(-Math.PI / 2);
  const tp = tg.attributes.position, col = new Float32Array(tp.count * 3), c = new THREE.Color();
  const soil = [.33, .25, .15], lush = [.2, .34, .11], dry = [.55, .5, .24];
  for(let i = 0; i < tp.count; i++){
    const x = tp.getX(i) + center.x, z = tp.getZ(i) + center.z, y = height(x, z); tp.setXYZ(i, x, y, z);
    const m = wet(x, z), dr = clamp(P.dry / 100 + (.5 - m) * .5, 0, 1), g = lush.map((v, k) => v + (dry[k] - v) * dr), s = smooth(.1, .45, m);
    c.setRGB(soil[0] + (g[0] - soil[0]) * s, soil[1] + (g[1] - soil[1]) * s, soil[2] + (g[2] - soil[2]) * s, THREE.SRGBColorSpace); col[i*3] = c.r; col[i*3+1] = c.g; col[i*3+2] = c.b;
  }
  tg.setAttribute('color', new THREE.BufferAttribute(col, 3)); tg.computeVertexNormals();
  const terrain = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({vertexColors: true, roughness: 1}));
  terrain.receiveShadow = true; terrain.matrixAutoUpdate = false; group.add(terrain);

  // ---- grass geometry: 4 quad segments + tip, unit height, unit width
  const SEGS = 4, pos = [], idx = [];
  for(let i = 0; i < SEGS; i++){ const t = i / SEGS, hw = .5 * (1 - Math.pow(t, 1.6) * .85); pos.push(-hw, t, 0, hw, t, 0); }
  pos.push(0, 1, 0);
  for(let i = 0; i < SEGS - 1; i++){ const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } idx.push((SEGS - 1) * 2, (SEGS - 1) * 2 + 1, SEGS * 2);
  const base = new THREE.BufferGeometry(); base.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); base.setIndex(idx);

  const sunDir = new THREE.Vector3(), sunCol = new THREE.Color(), amb = new THREE.Color(), fogCol = new THREE.Color(), horizon = new THREE.Color(), zenith = new THREE.Color();
  const U = {
    uTime: {value: 0}, uWind: {value: 0}, uGust: {value: 0}, uSpeed: {value: 1}, uScale: {value: 2 / span}, uHeight: {value: 1}, uDry: {value: .25}, uWindDir: {value: wind.dir},
    uBody: {value: new THREE.Vector4(center.x, center.z, span * .2, 1)}, uSpan: {value: span}, uCam: {value: new THREE.Vector3()}, uSun: {value: sunDir}, uSunCol: {value: new THREE.Vector3()},
    uAmb: {value: new THREE.Vector3()}, uFogCol: {value: new THREE.Vector3()}, uFogNear: {value: span * 1.6}, uFogFar: {value: span * 7},
  };
  const bladeMat = new THREE.ShaderMaterial({vertexShader: BLADE_VS, fragmentShader: BLADE_FS, uniforms: U, side: THREE.DoubleSide});
  const chunks = [], H = [.035, .075, .16], W = [.0032, .0036, .0042], FLEX = [.9, 1, 1.15];
  for(let ix = -K; ix <= K; ix++) for(let iz = -K; iz <= K; iz++){
    const x0 = center.x + (ix - .5) * cs, z0 = center.z + (iz - .5) * cs, rng = mulberry(hashStr(`${seed}:${ix}:${iz}`)), sx = rng(), sz = rng();
    const off = new Float32Array(N * 3), prm = new Float32Array(N * 4), msc = new Float32Array(N * 4); let n = 0;
    for(let i = 1; i < N * 3 && n < N; i++){
      const x = x0 + ((halton(i, 2) + sx) % 1) * cs, z = z0 + ((halton(i, 3) + sz) % 1) * cs, y = height(x, z);
      const sl = Math.hypot(height(x + span * .02, z) - y, height(x, z + span * .02) - y) / (span * .02), m = wet(x, z);
      if(rng() > clamp(1 - sl * 1.6, 0, 1) * (.3 + .7 * m)) continue;                       // thinner on slopes and dry ground
      if(Math.hypot(x - center.x, z - center.z) < span * .05) continue;                       // keep the footprint itself clear
      const pt = patch.fbm(x / span * 2.4, z / span * 2.4), sp = pt > .62 ? 2 : pt > .42 ? 1 : 0, hh = span * H[sp] * (.7 + .6 * rng()) * (sp === 2 ? .8 + m * .5 : 1);
      off.set([x, y, z], n * 3); prm.set([hh, span * W[sp] * (.8 + .4 * rng()), rng(), rng() * 6.2832], n * 4); msc.set([sp, clamp(rng() * .55 + pt * .55 - .15, 0, 1), FLEX[sp], rng() * .5 + (1 - m) * .5], n * 4); n++;
    }
    const g = new THREE.InstancedBufferGeometry(); g.index = base.index; g.setAttribute('position', base.attributes.position);
    g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off.subarray(0, n * 3), 3)); g.setAttribute('aParam', new THREE.InstancedBufferAttribute(prm.subarray(0, n * 4), 4)); g.setAttribute('aMisc', new THREE.InstancedBufferAttribute(msc.subarray(0, n * 4), 4));
    g.instanceCount = n; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(x0 + cs / 2, y0, z0 + cs / 2), cs * .75 + span * .3);
    const mesh = new THREE.Mesh(g, bladeMat); mesh.frustumCulled = true; mesh.userData.full = n; mesh.userData.c = g.boundingSphere.center; group.add(mesh); chunks.push(mesh);
  }

  // ---- sky dome (follows the camera) and sun
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, depthTest: false,
    uniforms: {uSun: {value: sunDir}, uSunCol: {value: U.uSunCol.value}, uHorizon: {value: new THREE.Vector3()}, uZenith: {value: new THREE.Vector3()}}}));
  dome.renderOrder = -10; dome.frustumCulled = false; group.add(dome);
  const lerp3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

  const api = {group, wind, sunDir, sunColor: sunCol, ground: height, params: P,
    setParams(p){
      Object.assign(P, p); wind.strength = P.wind / 100; wind.speed = .4 + P.speed / 50; wind.gust = P.gust / 100; wind.setAngle(P.dir);
      U.uHeight.value = .35 + P.height / 50 * .65; U.uDry.value = P.dry / 100;
      const e = P.sun * Math.PI / 180, az = -.6, k = smooth(3, 40, P.sun);                  // sun elevation tints light, sky and fog
      sunDir.set(Math.cos(e) * Math.cos(az), Math.sin(e), Math.cos(e) * Math.sin(az)).normalize();
      const sc = lerp3([1, .6, .34], [1, .96, .88], k), hz = lerp3([.95, .66, .5], [.76, .86, .95], k), zn = lerp3([.22, .24, .42], [.2, .43, .82], k), am = lerp3([.18, .15, .2], [.34, .4, .5], k);
      sunCol.setRGB(sc[0], sc[1], sc[2]); U.uSunCol.value.set(...sc); U.uAmb.value.set(...am); U.uFogCol.value.set(...hz);
      dome.material.uniforms.uHorizon.value.set(...hz); dome.material.uniforms.uZenith.value.set(...zn); fogCol.setRGB(hz[0], hz[1], hz[2], THREE.SRGBColorSpace);
      scene.fog = new THREE.Fog(fogCol, span * 1.6, span * 7);
    },
    update(t, camera){
      wind.time = t; U.uTime.value = t; U.uWind.value = wind.strength; U.uGust.value = wind.gust; U.uSpeed.value = wind.speed; U.uCam.value.copy(camera.position);
      dome.position.copy(camera.position); dome.scale.setScalar(camera.far * .45);
      const dens = P.density / 100;
      for(const m of chunks){ const d = camera.position.distanceTo(m.userData.c), f = Math.pow(clamp(1.12 - d / (span * 4.6), .08, 1), 1.4);
        m.geometry.instanceCount = Math.floor(m.userData.full * f * dens); }
    },
    dispose(){ scene.fog = null; scene.remove(group); group.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); }); },
  };
  api.setParams({}); scene.add(group);
  return api;
}
