// Living-world scene, phase 1 (+ variety / clouds / real shadows): terrain-aware, wind-driven meadow under the model.
//   WindSystem  - shared wind state; later systems (birds, leaves, ...) read the same object.
//   Terrain     - seeded height + moisture fields; flattened under the model so its feet sit on the ground.
//   Vegetation  - instanced, chunked, seeded Halton scatter (any prefix of a buffer is an even subset => LOD = instanceCount).
//                 grass in tufts with bare clearings, wildflowers in patches, weed rosettes, tall docks, fallen leaves,
//                 and leaves drifting in the air. One shared GPU wind (swell + sway + flutter + gusts), species-specific flex.
//   Light       - vegetation uses three's Lambert lighting, so it receives the model's REAL shadow-map shadow, sun and fog.
//   Sky         - gradient + sun + procedural clouds; the same cloud field casts moving shadows on the ground.
// Ideas adapted from CK42BB/procedural-grass-threejs, SkyeShark/SeedThree, Leonxlnx/sakura-realm (MIT); no code copied.
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

// ---------------------------------------------------------------- shared GLSL
const NOISE_GLSL = /* glsl */`
float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(hash21(i), hash21(i+vec2(1,0)), f.x), mix(hash21(i+vec2(0,1)), hash21(i+vec2(1,1)), f.x), f.y); }
float fbm4(vec2 p){ float s = 0., a = .5; for(int i = 0; i < 4; i++){ s += a * vnoise(p); p *= 2.03; a *= .5; } return s / .9375; }
`;
// cloud density at a world xz point on the cloud plane; drifts with the wind. Used by the sky AND by ground cloud-shadows.
const CLOUD_GLSL = /* glsl */`
uniform float uTime, uCover, uSpan, uSpeed; uniform vec2 uWindDir;
float cloudDensity(vec2 xz){
  vec2 q = (xz + uWindDir * uTime * uSpan * .35 * uSpeed) / (uSpan * 28.);
  float n = fbm4(q) * .75 + fbm4(q * 3.1 + 7.) * .25;
  return smoothstep(1. - uCover - .05, 1. - uCover + .22, n);
}
`;
const CLOUD_Y = 40;                                                // cloud plane height, in model spans

const VEG_HEAD = /* glsl */`
uniform float uHeight, uDry, uWind, uGust; uniform vec4 uBody; uniform vec3 uSunW;
attribute vec3 aOff; attribute vec4 aParam; attribute vec4 aMisc; attribute vec3 aColor; attribute float aPart; attribute float aAttach;
varying vec3 vCol3, vWorld; varying vec2 vLeafUv; varying float vLeaf, vTipT;
${NOISE_GLSL}
uniform float uTime, uSpan, uSpeed; uniform vec2 uWindDir;
float gAmp(vec2 wp, float ph){                                    // wind amplitude at a place: calm/blow patches x sway + gust packets
  float k = 2. / uSpan, travel = dot(wp, uWindDir);
  float slow = vnoise(wp * k * .6 - uWindDir * uTime * uSpeed * .35);
  float swell = .5 + .5 * sin(travel * k * 2.2 - uTime * uSpeed * 1.1 + ph * 6.2831);
  float gust = pow(.5 + .5 * sin(travel * k * .5 - uTime * uSpeed * .6), 4.);
  return uWind * (.25 + .75 * slow) * (.55 + .45 * swell) + uGust * gust;
}
// point on a bending stem of height h at parameter t (0..1), relative to the plant base
vec3 stem(float t, float h, float ph, float flex, float species){
  float amp = gAmp(aOff.xz, ph), flutter = sin(uTime * (6. + species * 2.5) + ph * 40. + t * 4.);
  vec2 d = uWindDir * (amp * flex * t * t * h * .55) + vec2(-uWindDir.y, uWindDir.x) * (flutter * .03 * amp * flex * t * h);
  vec2 bd = aOff.xz - uBody.xy; float br = length(bd), push = (1. - smoothstep(0., uBody.z, br)) * uBody.w;   // the model parts the plants
  d += (br > .001 ? bd / br : vec2(0.)) * push * h * t * t * 1.3;
  vec3 p = vec3(d.x, t * h * (1. - .5 * push * t), d.y); p.y -= dot(d, d) / (2. * h + 1e-4) * t; return p;
}
vec2 rot2(vec2 v, float a){ float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
`;
const VEG_FRAG_NORMAL = `vec3 normal = normalize(vNormal); vec3 nonPerturbedNormal = normal;`;   // no back-face flip: normals are authored "up-ish"
const VEG_FRAG_COLOR = /* glsl */`
  vec3 baseCol = vCol3;
  if(vLeaf > .5){ vec2 q = vLeafUv * 2. - 1.; vec2 e = q * vec2(1., .55); if(dot(e, e) > 1.) discard; baseCol *= 1. - .22 * smoothstep(.07, 0., abs(q.y)); }
  vec3 lin = pow(max(baseCol, 0.), vec3(2.2));
  float cs = cloudDensity(vWorld.xz + uSunW.xz / max(uSunW.y, .1) * uSpan * ${CLOUD_Y}.);   // cloud shadow
  lin *= (1. - .5 * cs) * 1.35;
  diffuseColor.rgb = lin;
`;
const VEG_FRAG_EMISSIVE = /* glsl */`
  { vec3 V = normalize(cameraPosition - vWorld);                      // light shining through the blade towards the camera
    totalEmissiveRadiance += lin * uSunCol * pow(max(dot(V, -uSunW), 0.), 3.) * vTipT * .5 * (1. - .6 * cs); }
`;

// Wraps a MeshLambertMaterial: custom vertex placement + colour, keeps three's lighting, shadows and fog.
function vegMaterial(U, vertexBody, key){
  const m = new THREE.MeshLambertMaterial({side: THREE.DoubleSide});
  m.customProgramCacheKey = () => 'veg-' + key;                // identical onBeforeCompile source would otherwise make three reuse ONE program for all kinds
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + VEG_HEAD)
      // the normal chunks run before begin_vertex, so the whole custom placement goes first and replaces both
      .replace('#include <beginnormal_vertex>', 'vec3 transformed = vec3(0.);\nvec3 vegNormal = vec3(0., 1., 0.);\n' + vertexBody + '\nvec3 objectNormal = vegNormal;')
      .replace('#include <begin_vertex>', '');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uSunCol; varying vec3 vCol3, vWorld; varying vec2 vLeafUv; varying float vLeaf, vTipT;\n' + NOISE_GLSL + CLOUD_GLSL + 'uniform vec3 uSunW;')
      .replace('#include <normal_fragment_begin>', VEG_FRAG_NORMAL).replace('#include <color_fragment>', '#include <color_fragment>\n' + VEG_FRAG_COLOR)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + VEG_FRAG_EMISSIVE);
    m.userData.shader = sh;
  };
  return m;
}
// vertex bodies: they set `transformed` (world position, mesh matrix is identity), `vegNormal`, vCol3, vWorld, vLeaf, vTipT, vLeafUv
const GRASS_VS = /* glsl */`
  float t = position.y, h = aParam.x * uHeight, ph = aParam.z, yaw = aParam.w;
  vec3 p = stem(t, h, ph, aMisc.z, aMisc.x);
  vec2 off = rot2(vec2(position.x * aParam.y, 0.), -yaw); p.xz += off;
  transformed = aOff + p; vWorld = transformed; vTipT = t; vLeaf = 0.; vLeafUv = vec2(0.);
  float dry = clamp(uDry + (aMisc.w - .5) * .7, 0., 1.);
  vec3 green = mix(vec3(.13, .29, .06), vec3(.31, .49, .12), aMisc.y), straw = mix(vec3(.47, .41, .19), vec3(.69, .6, .3), aMisc.y);
  vCol3 = mix(green, straw, dry) * (.7 + .5 * t) * mix(.3, 1., smoothstep(0., .65, t));
  vegNormal = normalize(vec3(sin(yaw), 0., cos(yaw)) * .25 + vec3(0., 1., 0.));
`;
const PLANT_VS = /* glsl */`                                            // flowers + docks: a bending stem with organs (petals / leaves) attached
  float h = aParam.x * uHeight, ph = aParam.z, yaw = aParam.w, size = aParam.y;
  float part = aPart; vLeaf = 0.; vLeafUv = vec2(0.); vTipT = 0.;
  vec3 p;
  if(part < .5){ float t = position.y; p = stem(t, h, ph, aMisc.z, aMisc.x); p.xz += rot2(vec2(position.x * h * .018, 0.), -yaw);
    vCol3 = mix(vec3(.17, .33, .08), vec3(.27, .45, .12), aMisc.y) * (.8 + .3 * t); vegNormal = vec3(0., 1., 0.); }
  else { vec3 a = stem(aAttach, h, ph, aMisc.z, aMisc.x), o = position * size; o.xz = rot2(o.xz, -yaw);
    // tilt organs with the stem's lean at the attachment point
    o.xz += (a.xz) * 0.; p = a + o; vegNormal = normalize(vec3(0., 1., 0.) + vec3(o.x, 0., o.z) * .2 / max(size, 1e-4));
    if(part < 1.5) vCol3 = aColor * (.82 + .3 * (1. - length(position.xz)));
    else if(part < 2.5) vCol3 = aMisc.x > 2.5 && aMisc.x < 3.5 ? vec3(.1, .07, .05) : vec3(.93, .72, .12);
    else { vCol3 = mix(vec3(.14, .3, .07), vec3(.26, .45, .12), aMisc.y) * (.7 + .5 * position.y / max(size, 1e-4) * size + .0); vLeaf = 0.; vTipT = .3; } }
  transformed = aOff + p; vWorld = transformed;
`;
const ROSETTE_VS = /* glsl */`                                          // low leaf rosettes (dandelion / plantain)
  float size = aParam.y * uHeight * .8 + aParam.y * .2, yaw = aParam.w, ph = aParam.z;
  vec3 o = position * size; o.xz = rot2(o.xz, -yaw);
  float amp = gAmp(aOff.xz, ph); vec2 d = uWindDir * amp * .12 * (position.y + length(position.xz) * .4) * size; o.xz += d;
  vec2 bd = aOff.xz - uBody.xy; float br = length(bd), push = (1. - smoothstep(0., uBody.z, br)) * uBody.w; o.xz += (br > .001 ? bd / br : vec2(0.)) * push * size * .5;
  transformed = aOff + o; vWorld = transformed; vLeaf = 0.; vLeafUv = vec2(0.); vTipT = .25;
  vCol3 = mix(vec3(.15, .31, .07), vec3(.27, .46, .12), aMisc.y) * (.65 + .5 * clamp(length(position.xz), 0., 1.));
  vegNormal = normalize(vec3(0., 1., 0.) + vec3(position.x, 0., position.z) * .3);
`;
const LEAF_VS = /* glsl */`                                             // fallen leaves: lie flat, skitter a little in strong gusts
  float size = aParam.y, yaw = aParam.w, ph = aParam.z;
  float amp = gAmp(aOff.xz, ph); float lift = smoothstep(.55, 1.1, amp);
  vec3 o = vec3(position.x, 0., position.z) * size; o.y += position.y * size * .0;
  float spin = yaw + lift * sin(uTime * 3. + ph * 20.) * .6; o.xz = rot2(o.xz, -spin);
  o.y += (.01 + lift * .25 * abs(sin(uTime * 4. + ph * 30.))) * size; o.xz += uWindDir * lift * size * .6 * sin(uTime * 2. + ph * 10.);
  transformed = aOff + o; vWorld = transformed; vLeaf = 1.; vLeafUv = position.xz * .5 / max(.5, 1.) + .5; vTipT = .2; vCol3 = aColor;
  vegNormal = normalize(vec3(0., 1., 0.) + vec3(sin(spin), 0., cos(spin)) * .12);
`;
const FALL_VS = /* glsl */`                                             // leaves in the air: fall, drift with the wind, tumble; wrap around the model
  float size = aParam.y, ph = aParam.z, box = uSpan * 5.;
  float tt = uTime * (.25 + ph * .2) + aParam.w * 7.;
  vec2 xz = uBody.xy + (fract(aOff.xz / box + uWindDir * uTime * uSpan * .06 / box * (.6 + ph) + .5) - .5) * box;
  float top = uSpan * 1.8, y = top - fract(aOff.y + uTime * (.035 + .03 * ph) * uSpan * .5 / top) * top;
  xz += vec2(sin(tt * 1.7 + ph * 9.), cos(tt * 1.3 + ph * 5.)) * uSpan * .08;
  vec3 o = vec3(position.x, 0., position.z) * size;
  float a1 = tt * 2.1 + ph * 6., a2 = tt * 1.6; o.xy = rot2(o.xy, sin(a1) * 1.1); o.yz = rot2(o.yz, sin(a2) * 1.0); o.xz = rot2(o.xz, tt);
  transformed = vec3(xz.x, uBody.w * 0. + ${'GROUND_Y'} + y, xz.y) + o; vWorld = transformed; vLeaf = 1.; vLeafUv = position.xz * .5 + .5; vTipT = .4; vCol3 = aColor;
  vegNormal = vec3(0., 1., 0.);
`;

const SKY_VS = `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`;
const SKY_FS = /* glsl */`uniform vec3 uSun, uSunCol, uHorizon, uZenith, uCam, uCloudCol; varying vec3 vDir;
${NOISE_GLSL}${CLOUD_GLSL}
void main(){ vec3 d = normalize(vDir); float h = clamp(d.y, 0., 1.);
  vec3 col = mix(uHorizon, uZenith, pow(h, .55)); float s = max(dot(d, uSun), 0.);
  col += uSunCol * (pow(s, 700.) * 3. + pow(s, 10.) * .22);
  if(d.y > .02){                                                         // clouds: intersect the view ray with the cloud plane
    float ty = (uSpan * ${CLOUD_Y}. - uCam.y) / d.y; vec2 xz = uCam.xz + d.xz * ty;
    float c = cloudDensity(xz), cs = cloudDensity(xz + uSun.xz / max(uSun.y, .15) * uSpan * 1.6);
    float lit = clamp(1. - (c - cs) * 1.6 - c * .25, .35, 1.);              // thicker / further from the sun = darker underside
    vec3 cc = mix(uCloudCol * .72, mix(uCloudCol, uSunCol * 1.15, .35), lit);
    col = mix(col, cc, c * smoothstep(.02, .22, d.y) * .94);
  }
  col = mix(col, uHorizon * .96, smoothstep(0., -.18, d.y));
  gl_FragColor = vec4(col, 1.); }`;

export const MEADOW_DEFAULTS = {height: 50, density: 70, wind: 45, speed: 50, gust: 35, dir: 35, dry: 25, rough: 35, sun: 42, flowers: 70, weeds: 70, leaves: 60, fall: 60, clouds: 45};

// ---------------------------------------------------------------- geometries (all "unit" sized; per-instance attributes scale them)
function geo(parts){                                               // parts: [{pos[], idx[], part, attach[]}] -> one indexed BufferGeometry
  const pos = [], part = [], att = [], idx = []; let base = 0;
  for(const g of parts){ for(let i = 0; i < g.pos.length; i += 3){ pos.push(g.pos[i], g.pos[i + 1], g.pos[i + 2]); part.push(g.part); att.push(g.attach ? g.attach[i / 3] : g.pos[i + 1]); }
    for(const i of g.idx) idx.push(base + i); base += g.pos.length / 3; }
  const b = new THREE.BufferGeometry(); b.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); b.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  b.setAttribute('aAttach', new THREE.Float32BufferAttribute(att, 1)); b.setIndex(idx); return b;
}
function ribbon(segs, taper, power = 1.6){                          // vertical tapered ribbon, unit height, unit width
  const pos = [], idx = [];
  for(let i = 0; i < segs; i++){ const t = i / segs, hw = .5 * (1 - Math.pow(t, power) * taper); pos.push(-hw, t, 0, hw, t, 0); }
  pos.push(0, 1, 0);
  for(let i = 0; i < segs - 1; i++){ const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } idx.push((segs - 1) * 2, (segs - 1) * 2 + 1, segs * 2);
  return {pos, idx};
}
function leafBlade(len, wid, rise, ang, y0 = 0, segs = 3){          // a leaf growing outward at angle `ang` (xz) from a point, arching upward
  const pos = [], idx = [], ca = Math.cos(ang), sa = Math.sin(ang);
  for(let i = 0; i <= segs; i++){ const t = i / segs, w = wid * Math.sin(Math.PI * Math.pow(t, .7)) * .5 + (i === segs ? 0 : .0001), r = len * t, y = y0 + rise * Math.sin(t * 1.4) - rise * .3 * t * t;
    pos.push(ca * r - sa * w, y, sa * r + ca * w, ca * r + sa * w, y, sa * r - ca * w); }
  for(let i = 0; i < segs; i++){ const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  return {pos, idx};
}

export function createMeadow({scene, span, center, seed = '1', params = {}, wind = new WindSystem()}){
  const P = {...MEADOW_DEFAULTS, ...params}, group = new THREE.Group(), cs = span * .75, K = 3, KI = 2, y0 = center.y;
  const noise = new Noise(hashStr(seed)), moist = new Noise(hashStr(seed + 'm')), patch = new Noise(hashStr(seed + 'p')), clear = new Noise(hashStr(seed + 'c')), flo = new Noise(hashStr(seed + 'f'));
  group.name = 'meadow';

  // ---- terrain
  const amp = () => span * .09 * P.rough / 100;
  const height = (x, z) => { const r = Math.hypot(x - center.x, z - center.z), flat = smooth(span * .3, span * 1.1, r);
    return y0 + (noise.fbm(x / span * .9, z / span * .9) - .5) * 2 * amp() * flat + (noise.fbm(x / span * .25 + 9, z / span * .25) - .4) * span * .5 * smooth(span * 4, span * 9, r); };
  const wet = (x, z) => clamp(moist.fbm(x / span * .7 + 3, z / span * .7 - 5) * 1.5 - .15, 0, 1);
  const bare = (x, z) => 1 - smooth(.2, .5, clear.fbm(x / span * 1.4 + 11, z / span * 1.4 - 3));           // 1 = bare soil patch (clearing)
  const T = span * 14, SEG = 160, tg = new THREE.PlaneGeometry(T * 2, T * 2, SEG, SEG); tg.rotateX(-Math.PI / 2);
  const tp = tg.attributes.position, col = new Float32Array(tp.count * 3), c = new THREE.Color();
  const soil = [.33, .25, .15], lush = [.2, .34, .11], dry = [.55, .5, .24];
  for(let i = 0; i < tp.count; i++){
    const x = tp.getX(i) + center.x, z = tp.getZ(i) + center.z, y = height(x, z); tp.setXYZ(i, x, y, z);
    const m = wet(x, z), dr = clamp(P.dry / 100 + (.5 - m) * .5, 0, 1), g = lush.map((v, k) => v + (dry[k] - v) * dr), s = smooth(.1, .45, m) * (1 - .75 * bare(x, z));
    c.setRGB(soil[0] + (g[0] - soil[0]) * s, soil[1] + (g[1] - soil[1]) * s, soil[2] + (g[2] - soil[2]) * s, THREE.SRGBColorSpace); col[i*3] = c.r; col[i*3+1] = c.g; col[i*3+2] = c.b;
  }
  tg.setAttribute('color', new THREE.BufferAttribute(col, 3)); tg.computeVertexNormals();

  const sunDir = new THREE.Vector3(), sunCol = new THREE.Color();
  const U = {
    uTime: {value: 0}, uWind: {value: 0}, uGust: {value: 0}, uSpeed: {value: 1}, uHeight: {value: 1}, uDry: {value: .25}, uWindDir: {value: wind.dir}, uSpan: {value: span},
    uBody: {value: new THREE.Vector4(center.x, center.z, span * .2, 1)}, uSunW: {value: sunDir}, uSunCol: {value: new THREE.Vector3()}, uCover: {value: .45},
  };
  const terrainMat = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 1});
  terrainMat.onBeforeCompile = sh => {                                // ground gets the same moving cloud shadows
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWorldT;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorldT = (modelMatrix * vec4(transformed, 1.)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWorldT; uniform vec3 uSunW;\n' + NOISE_GLSL + CLOUD_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 1. - .5 * cloudDensity(vWorldT.xz + uSunW.xz / max(uSunW.y, .1) * uSpan * ' + CLOUD_Y + '.);');
  };
  const terrain = new THREE.Mesh(tg, terrainMat); terrain.receiveShadow = true; terrain.matrixAutoUpdate = false; group.add(terrain);

  // ---- vegetation kinds
  const grassGeo = geo([{...ribbon(4, .85), part: 0}]);
  const petalAngles = [...Array(8).keys()].map(i => i / 8 * Math.PI * 2), headParts = [];
  { const pos = [], idx = []; petalAngles.forEach((a, i) => { const ca = Math.cos(a), sa = Math.sin(a), l = Math.cos(a + .39), s2 = Math.sin(a + .39), r = Math.cos(a - .39), s3 = Math.sin(a - .39), b = i * 4;
      pos.push(0, 0, 0,  .55 * l, .1, .55 * s2,  ca, .18, sa,  .55 * r, .1, .55 * s3); idx.push(b, b + 1, b + 2, b, b + 2, b + 3); });
    headParts.push({pos, idx, part: 1, attach: pos.map((_, i) => i % 3 === 0 ? 1 : null).filter(v => v !== null)});
    const cp = [], ci = []; for(let i = 0; i < 6; i++){ const a = i / 6 * Math.PI * 2; cp.push(Math.cos(a) * .28, .22, Math.sin(a) * .28); ci.push(i, (i + 1) % 6, 6); } cp.push(0, .3, 0);
    headParts.push({pos: cp, idx: ci, part: 2, attach: Array(7).fill(1)}); }
  const flowerGeo = geo([{...ribbon(4, .1, 1), part: 0}, ...headParts]);
  const dockParts = [{...ribbon(4, .2, 1), part: 0}];
  [[.3, 0], [.5, 2.1], [.7, 4.2]].forEach(([t, a]) => { const l = leafBlade(1, .5, .25, a, 0, 3); dockParts.push({...l, part: 3, attach: Array(l.pos.length / 3).fill(t)}); });
  const dockGeo = geo(dockParts);
  const rosParts = []; for(let i = 0; i < 8; i++) rosParts.push({...leafBlade(1, .38, .35, i / 8 * Math.PI * 2 + .2, 0, 3), part: 3});
  const rosGeo = geo(rosParts);
  const leafQuad = geo([{pos: [-1, 0, -1, 1, 0, -1, -1, 0, 1, 1, 0, 1], idx: [0, 1, 2, 1, 3, 2], part: 4}]);

  const grassMat = vegMaterial(U, GRASS_VS, 'grass'), plantMat = vegMaterial(U, PLANT_VS, 'plant'), rosMat = vegMaterial(U, ROSETTE_VS, 'rosette'), leafMat = vegMaterial(U, LEAF_VS, 'leaf');
  const fallMat = vegMaterial(U, FALL_VS.replace('GROUND_Y', y0.toFixed(4)), 'fall');
  
  const FL = [[.97, .96, .92], [.98, .82, .1], [.58, .36, .72], [.82, .1, .08], [.9, .55, .7]];           // daisy, buttercup, vetch, poppy, pink clover
  const AUT = [[.55, .3, .1], [.7, .5, .12], [.45, .25, .08], [.6, .55, .2], [.38, .3, .1]];             // leaf browns / ochres
  const kinds = {grass: {geo: grassGeo, mat: grassMat, N: 4200, R: K}, flowers: {geo: flowerGeo, mat: plantMat, N: 320, R: KI}, docks: {geo: dockGeo, mat: plantMat, N: 10, R: KI},
    weeds: {geo: rosGeo, mat: rosMat, N: 60, R: KI}, leaves: {geo: leafQuad, mat: leafMat, N: 110, R: KI}};
  const chunks = [], H = [.035, .075, .16], W = [.0032, .0036, .0042], FLEX = [.9, 1, 1.15];
  const slopeAt = (x, z, y) => Math.hypot(height(x + span * .02, z) - y, height(x, z + span * .02) - y) / (span * .02);
  const make = (kind, ix, iz, x0, z0, build) => {
    const k = kinds[kind], rng = mulberry(hashStr(`${seed}:${kind}:${ix}:${iz}`)), sx = rng(), sz = rng();
    const off = new Float32Array(k.N * 3), prm = new Float32Array(k.N * 4), msc = new Float32Array(k.N * 4), clr = new Float32Array(k.N * 3); let n = 0;
    const pt = i => [x0 + ((halton(i, 2) + sx) % 1) * cs, z0 + ((halton(i, 3) + sz) % 1) * cs];
    const put = (x, z, y, p, m, cl) => { off.set([x, y, z], n * 3); prm.set(p, n * 4); msc.set(m, n * 4); if(cl) clr.set(cl, n * 3); n++; };
    build({rng, pt, put, count: () => n, N: k.N});
    const g = new THREE.InstancedBufferGeometry(); g.index = k.geo.index; for(const a of ['position', 'aPart', 'aAttach']) g.setAttribute(a, k.geo.attributes[a]);
    g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off.subarray(0, n * 3), 3)); g.setAttribute('aParam', new THREE.InstancedBufferAttribute(prm.subarray(0, n * 4), 4));
    g.setAttribute('aMisc', new THREE.InstancedBufferAttribute(msc.subarray(0, n * 4), 4)); g.setAttribute('aColor', new THREE.InstancedBufferAttribute(clr.subarray(0, n * 3), 3));
    g.instanceCount = n; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(x0 + cs / 2, y0, z0 + cs / 2), cs * .75 + span * .4);
    const mesh = new THREE.Mesh(g, k.mat); mesh.receiveShadow = true; mesh.userData = {full: n, c: g.boundingSphere.center, kind}; group.add(mesh); chunks.push(mesh);
  };
  for(let ix = -K; ix <= K; ix++) for(let iz = -K; iz <= K; iz++){
    const x0 = center.x + (ix - .5) * cs, z0 = center.z + (iz - .5) * cs, inner = Math.abs(ix) <= KI && Math.abs(iz) <= KI;
    const ok = (x, z, rng, p) => rng() < p && Math.hypot(x - center.x, z - center.z) > span * .05;
    // grass: clumps ("tufts") with a loose scatter between them; thinner on slopes, dry ground and in clearings
    make('grass', ix, iz, x0, z0, ({rng, pt, put, count, N}) => {
      for(let i = 1; i < N * 3 && count() < N; i++){
        const [cx, cz] = pt(i), cy = height(cx, cz), m = wet(cx, cz), b = bare(cx, cz), sl = slopeAt(cx, cz, cy);
        if(!ok(cx, cz, rng, clamp(1 - sl * 1.6, 0, 1) * (.3 + .7 * m) * (1 - .92 * b))) continue;
        const pn = patch.fbm(cx / span * 2.4, cz / span * 2.4), sp = pn > .62 ? 2 : pn > .42 ? 1 : 0, tuft = rng() < .6 ? 6 + ((rng() * 7) | 0) : 1;
        for(let j = 0; j < tuft && count() < N; j++){
          const a = rng() * 6.2832, r = tuft > 1 ? span * .02 * Math.sqrt(rng()) : 0, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r, y = height(x, z);
          const hh = span * H[sp] * (.65 + .7 * rng()) * (sp === 2 ? .8 + m * .5 : 1) * (tuft > 1 ? 1 : .8);
          put(x, z, y, [hh, span * W[sp] * (.8 + .4 * rng()), rng(), rng() * 6.2832], [sp, clamp(rng() * .55 + pn * .55 - .15, 0, 1), FLEX[sp], rng() * .5 + (1 - m) * .5]);
        }
      } });
    if(!inner) continue;
    // wildflowers: in patches, species chosen by a second noise field
    make('flowers', ix, iz, x0, z0, ({rng, pt, put, count, N}) => {
      for(let i = 1; i < N * 6 && count() < N; i++){
        const [x, z] = pt(i), fp = flo.fbm(x / span * 1.7, z / span * 1.7); if(fp < .44 || !ok(x, z, rng, smooth(.44, .58, fp) * (1 - .9 * bare(x, z)))) continue;
        const y = height(x, z), sp = Math.min(4, Math.floor(flo.fbm(x / span * .6 + 40, z / span * .6) * 5.5)), cl = FL[sp].map(v => clamp(v * (.9 + .2 * rng()), 0, 1));
        put(x, z, y, [span * (.06 + .07 * rng()), span * (.014 + .011 * rng()), rng(), rng() * 6.2832], [sp, rng(), .8, 0], cl);
      } });
    make('docks', ix, iz, x0, z0, ({rng, pt, put, count, N}) => {
      for(let i = 1; i < N * 8 && count() < N; i++){ const [x, z] = pt(i); if(!ok(x, z, rng, .12 * (1 - bare(x, z)))) continue; const y = height(x, z);
        put(x, z, y, [span * (.12 + .09 * rng()), span * (.05 + .03 * rng()), rng(), rng() * 6.2832], [9, rng(), .45, 0]); } });
    make('weeds', ix, iz, x0, z0, ({rng, pt, put, count, N}) => {
      for(let i = 1; i < N * 5 && count() < N; i++){ const [x, z] = pt(i), m = wet(x, z); if(!ok(x, z, rng, (.25 + .6 * (1 - Math.abs(m - .5) * 2)) * (1 - .6 * bare(x, z)))) continue;
        put(x, z, height(x, z), [1, span * (.025 + .025 * rng()), rng(), rng() * 6.2832], [9, rng(), .3, 0]); } });
    make('leaves', ix, iz, x0, z0, ({rng, pt, put, count, N}) => {
      for(let i = 1; i < N * 3 && count() < N; i++){ const [x, z] = pt(i); if(!ok(x, z, rng, .7)) continue; const a = AUT[(rng() * AUT.length) | 0], f = .8 + .4 * rng();
        put(x, z, height(x, z), [1, span * (.008 + .008 * rng()), rng(), rng() * 6.2832], [9, rng(), .3, 0], a.map(v => clamp(v * f, 0, 1))); } });
  }
  // drifting leaves: one draw call, positions fully animated on the GPU
  { const N = 90, rng = mulberry(hashStr(seed + 'fall')), off = new Float32Array(N * 3), prm = new Float32Array(N * 4), msc = new Float32Array(N * 4), clr = new Float32Array(N * 3);
    for(let i = 0; i < N; i++){ off.set([rng() * 1e3, rng(), rng() * 1e3], i * 3); prm.set([1, span * (.01 + .008 * rng()), rng(), rng()], i * 4); const a = AUT[(rng() * AUT.length) | 0]; clr.set(a, i * 3); }
    const g = new THREE.InstancedBufferGeometry(); g.index = leafQuad.index; for(const a of ['position', 'aPart', 'aAttach']) g.setAttribute(a, leafQuad.attributes[a]);
    g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 3)); g.setAttribute('aParam', new THREE.InstancedBufferAttribute(prm, 4)); g.setAttribute('aMisc', new THREE.InstancedBufferAttribute(msc, 4)); g.setAttribute('aColor', new THREE.InstancedBufferAttribute(clr, 3));
    g.instanceCount = N; const mesh = new THREE.Mesh(g, fallMat); mesh.frustumCulled = false; mesh.userData = {full: N, kind: 'fall'}; group.add(mesh); chunks.push(mesh); }

  // ---- sky dome (follows the camera) with clouds
  const skyU = {uSun: {value: sunDir}, uSunCol: {value: U.uSunCol.value}, uHorizon: {value: new THREE.Vector3()}, uZenith: {value: new THREE.Vector3()}, uCam: {value: new THREE.Vector3()}, uCloudCol: {value: new THREE.Vector3(.97, .97, .98)},
    uTime: U.uTime, uCover: U.uCover, uSpan: U.uSpan, uSpeed: U.uSpeed, uWindDir: U.uWindDir};
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20), new THREE.ShaderMaterial({vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, depthTest: false, uniforms: skyU}));
  dome.renderOrder = -10; dome.frustumCulled = false; group.add(dome);
  const lerp3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t), fogCol = new THREE.Color();

  const api = {group, wind, sunDir, sunColor: sunCol, skyColor: new THREE.Color(), groundColor: new THREE.Color(.33, .25, .15), ground: height, params: P,
    setParams(p){
      Object.assign(P, p); wind.strength = P.wind / 100; wind.speed = .4 + P.speed / 50; wind.gust = P.gust / 100; wind.setAngle(P.dir); U.uCover.value = P.clouds / 100 * .75;
      U.uHeight.value = .35 + P.height / 50 * .65; U.uDry.value = P.dry / 100;
      const e = P.sun * Math.PI / 180, az = -.6, k = smooth(3, 40, P.sun);                  // sun elevation tints light, sky, clouds and fog
      sunDir.set(Math.cos(e) * Math.cos(az), Math.sin(e), Math.cos(e) * Math.sin(az)).normalize();
      const sc = lerp3([1, .6, .34], [1, .96, .88], k), hz = lerp3([.95, .66, .5], [.76, .86, .95], k), zn = lerp3([.22, .24, .42], [.2, .43, .82], k);
      sunCol.setRGB(sc[0], sc[1], sc[2]); U.uSunCol.value.set(...sc); skyU.uHorizon.value.set(...hz); skyU.uZenith.value.set(...zn); skyU.uCloudCol.value.set(...lerp3([1, .86, .78], [.98, .98, 1], k));
      fogCol.setRGB(hz[0], hz[1], hz[2], THREE.SRGBColorSpace); api.skyColor.setRGB(zn[0], zn[1], zn[2], THREE.SRGBColorSpace);
      scene.fog = new THREE.Fog(fogCol, span * 1.6, span * 7);
    },
    update(t, camera){
      wind.time = t; U.uTime.value = t; U.uWind.value = wind.strength; U.uGust.value = wind.gust; U.uSpeed.value = wind.speed; skyU.uCam.value.copy(camera.position);
      dome.position.copy(camera.position); dome.scale.setScalar(camera.far * .45);
      const dens = P.density / 100, share = {grass: dens, flowers: P.flowers / 100, weeds: P.weeds / 100, leaves: P.leaves / 100, docks: P.weeds / 100, fall: P.fall / 100};
      for(const m of chunks){
        if(m.userData.kind === 'fall'){ m.geometry.instanceCount = Math.floor(m.userData.full * clamp(share.fall, 0, 1)); continue; }
        const d = camera.position.distanceTo(m.userData.c), lod = m.userData.kind === 'grass' ? Math.pow(clamp(1.12 - d / (span * 4.6), .08, 1), 1.4) : clamp(1.2 - d / (span * 2.6), 0, 1);
        m.geometry.instanceCount = Math.floor(m.userData.full * lod * clamp(share[m.userData.kind], 0, 1)); m.visible = m.geometry.instanceCount > 0;
      }
    },
    stats(){ const o = {}; for(const m of chunks){ const k = m.userData.kind; o[k] = o[k] || {buffered: 0, drawn: 0}; o[k].buffered += m.userData.full; o[k].drawn += m.visible ? m.geometry.instanceCount : 0; } return o; },
    dispose(){ scene.fog = null; scene.remove(group); group.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); }); },
  };
  api.setParams({}); scene.add(group);
  return api;
}
