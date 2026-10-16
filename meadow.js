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
uniform float uHeight, uDry, uWind, uGust, uSeason, uWet; uniform vec4 uBodies[6]; uniform vec3 uSunW, uCamPos;   // bodies[0] = the model; 1.. = animals
attribute vec3 aOff; attribute vec4 aParam; attribute vec4 aMisc; attribute vec3 aColor; attribute float aPart; attribute float aAttach;
varying vec3 vCol3, vWorld, vBlade; varying vec2 vLeafUv; varying float vLeaf, vTipT, vPh;
${NOISE_GLSL}
uniform float uTime, uSpan, uSpeed; uniform vec2 uWindDir;
float gAmp(vec2 wp, float ph){                                    // wind amplitude at a place: calm/blow patches x sway + gust packets
  float k = 2. / uSpan, travel = dot(wp, uWindDir);
  float slow = vnoise(wp * k * .6 - uWindDir * uTime * uSpeed * .35);
  float swell = .5 + .5 * sin(travel * k * 2.2 - uTime * uSpeed * 1.1 + ph * .9);        // one travelling wave front; a plant's phase only jitters it slightly
  float gust = pow(.5 + .5 * sin(travel * k * .5 - uTime * uSpeed * .6), 4.);
  float ripple = sin(travel * k * 7. - uTime * uSpeed * 2.6 + ph * .7) * .1;          // faint quick ripples riding the swell
  return uWind * (.25 + .75 * slow) * (.55 + .45 * swell + ripple) + uGust * gust;
}
// point on a bending stem of height h at parameter t (0..1), relative to the plant base
vec3 stem(float t, float h, float ph, float flex, float species){
  float amp = gAmp(aOff.xz, ph);
  if(flex < .3) amp *= smoothstep(.4, 1., amp);                                              // lotus flowers etc.: barely move unless a real gust comes through
  float flutter = sin(uTime * 7. + ph * 3. + t * 4.) * smoothstep(.45, 1.1, amp);             // leaf flutter exists only in strong wind, not as constant animation
  vec2 d = uWindDir * (amp * flex * t * t * h * .42) + vec2(-uWindDir.y, uWindDir.x) * (flutter * .03 * amp * flex * t * h);
  float push = 0.; vec2 pd = vec2(0.);                                  // bodies (the model, animals) part the plants
  for(int i = 0; i < 6; i++){ vec4 b = uBodies[i]; if(b.w <= 0.) continue; vec2 bd = aOff.xz - b.xy; float br = length(bd), pu = (1. - smoothstep(0., b.z, br)) * b.w;
    if(pu > 0.){ pd += (br > .001 ? bd / br : vec2(0.)) * pu; push = max(push, pu); } }
  d += pd * h * t * t * 1.3;
  vec3 p = vec3(d.x, t * h * (1. - .5 * push * t), d.y); p.y -= dot(d, d) / (2. * h + 1e-4) * t; return p;
}
vec2 rot2(vec2 v, float a){ float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
`;
const VEG_FRAG_NORMAL = `vec3 normal = normalize(vNormal); vec3 nonPerturbedNormal = normal;`;   // no back-face flip: normals are authored "up-ish"
const VEG_FRAG_COLOR = /* glsl */`
  vec3 baseCol = vCol3;
  if(vLeaf > .5 && vLeaf < 1.5){ vec2 q = vLeafUv * 2. - 1.;                                              // a real leaf outline: pointed oval, each leaf slightly different, midrib
    float prof = (.5 + .22 * hash21(vec2(vPh * 17., 4.))) * pow(max(1. - q.x * q.x, 0.), .65 + .3 * hash21(vec2(vPh * 5., 9.)));
    if(abs(q.y) > prof) discard; baseCol *= 1. - .22 * smoothstep(.06, 0., abs(q.y)) - .12 * smoothstep(prof * .6, prof, abs(q.y)); }
  if(vLeaf > 1.5){                                                        // lily pad: occasional bites/holes, radial veins
    float a = atan(vLeafUv.y, vLeafUv.x), rr = length(vLeafUv);
    float bite = hash21(vec2(floor((a + 3.1416) * 1.3), floor(vPh * 61.)));
    if(bite > .92 && rr > .5 + .3 * hash21(vec2(vPh * 7., 3.))) discard;
    if(hash21(floor(vLeafUv * 9. + vPh * 40.)) > .985 && rr > .2) discard;
    baseCol *= 1. - .14 * smoothstep(.0, .05, abs(sin(a * 8.))) * smoothstep(.15, .5, rr);
  }
  if(vBlade.z > .5){                                                  // blade texture: midrib, fine parallel veins, dark edges, bleached base, patchy tone
    float ax = vBlade.x, bt = vBlade.y;
    baseCol *= 1. - .10 * (.5 + .5 * cos(ax * 18.));
    baseCol *= 1. - .24 * smoothstep(.55, 1., abs(ax));
    baseCol = mix(baseCol, baseCol * vec3(1.2, 1.14, .8) + vec3(.04, .05, 0.), smoothstep(.16, 0., abs(ax)) * .45);
    baseCol = mix(baseCol, vec3(.66, .7, .38), (1. - smoothstep(0., .22, bt)) * .5);
    baseCol *= .88 + .24 * vnoise(vWorld.xz * .35 + bt * 2.);
    baseCol *= .88 + .24 * vnoise(vWorld.xz / uSpan * 1.3 + 3.);                                              // large-scale tone: lighter and darker stretches of meadow
  }
  if(vBlade.z < .5) baseCol *= 1. - .2 * uWet;                                 // rain soaks every plant, same shared state as the ground
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
      .replace('#include <beginnormal_vertex>', 'vec3 transformed = vec3(0.);\nvec3 vegNormal = vec3(0., 1., 0.); vBlade = vec3(0.); vPh = 0.;\n' + vertexBody + '\nvec3 objectNormal = vegNormal;')
      .replace('#include <begin_vertex>', '');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uSunCol; uniform float uWet; varying vec3 vCol3, vWorld, vBlade; varying vec2 vLeafUv; varying float vLeaf, vTipT, vPh;\n' + NOISE_GLSL + CLOUD_GLSL + 'uniform vec3 uSunW;')
      .replace('#include <normal_fragment_begin>', VEG_FRAG_NORMAL).replace('#include <color_fragment>', '#include <color_fragment>\n' + VEG_FRAG_COLOR)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + VEG_FRAG_EMISSIVE);
    m.userData.shader = sh;
  };
  return m;
}
// vertex bodies: they set `transformed` (world position, mesh matrix is identity), `vegNormal`, vCol3, vWorld, vLeaf, vTipT, vLeafUv
const GRASS_VS = /* glsl */`
  float t = position.y, h = aParam.x * uHeight, ph = aParam.z, yaw = aParam.w;
  float near = smoothstep(.25 * uSpan, 1.6 * uSpan, distance(aOff, uCamPos));                   // 0 right at the camera .. 1 further than ~1.6 body heights
  h *= mix(.3, 1., near); if(fract(ph * 91.7) > mix(.3, 1., near)) h = 0.;                        // near the lens: shorter and sparser, so the foreground frames the subject
  vec3 p = stem(t, h, ph, aMisc.z, aMisc.x);
  vec2 lean = vec2(cos(yaw + 1.5708), sin(yaw + 1.5708)) * (h * (.12 + .45 * fract(ph * 13.7)) * t * t);   // each blade arches over to its own side
  p.xz += lean; p.y -= dot(lean, lean) / (2. * h + 1e-4);
  vec2 off = rot2(vec2(position.x, position.z) * aParam.y, -yaw); p.xz += off * (h > 0. ? 1. : 0.);                  // thinned-out blades collapse completely
  float hw = .5 * (1. - pow(t, 1.5) * .92) + 1e-3; vBlade = vec3(position.x / hw, t, 1.);
  transformed = aOff + p; vWorld = transformed; vTipT = t; vLeaf = 0.; vLeafUv = vec2(0.);
  float dry = clamp(uDry + (aMisc.w - .5) * .7, 0., 1.);
  vec3 green = mix(vec3(.13, .29, .06), vec3(.31, .49, .12), aMisc.y), straw = mix(vec3(.47, .41, .19), vec3(.69, .6, .3), aMisc.y);
  float aut = smoothstep(1.2, 2., uSeason) * (1. - smoothstep(2.6, 3., uSeason)), win = smoothstep(2.4, 3., uSeason);     // season: 0 spring, 1 summer, 2 autumn, 3 winter
  vec3 autCol = mix(vec3(.62, .42, .12), vec3(.78, .58, .22), aMisc.y), frost = mix(vec3(.74, .72, .6), vec3(.86, .9, .92), aMisc.y * .5);
  vec3 col = mix(mix(green, straw, dry), autCol, aut * .85); col = mix(col, frost, win * .8); col *= 1. + (1. - smoothstep(0., 1., uSeason)) * .12 - uWet * .25;
  col *= aMisc.x < .5 ? vec3(1.12, 1.05, .8) : aMisc.x > 1.5 ? vec3(.8, 1., 1.1) : vec3(1.);                    // species: lawn yellow-green, tall grass blue-green
  col = mix(col, straw * .95, smoothstep(.55, 1., t) * aMisc.w * .7);                                         // older blades yellow towards the tip
  vCol3 = col * (.7 + .5 * t) * mix(.3, 1., smoothstep(0., .65, t));
  vegNormal = normalize(vec3(sin(yaw), 0., cos(yaw)) * (.55 * sign(position.x)) + vec3(0., 1., 0.));       // the two halves of the fold catch light differently
`;
const PLANT_VS = /* glsl */`                                            // flowers, lotus, docks, cattails, reeds: a bending stem with organs (petals / leaves / heads / plumes) attached
  float h = aParam.x * uHeight, ph = aParam.z, yaw = aParam.w, size = aParam.y;
  h *= mix(.55, 1., smoothstep(.2 * uSpan, 1.2 * uSpan, distance(aOff, uCamPos)));                 // shorter right at the camera
  float part = aPart; vLeaf = 0.; vLeafUv = vec2(0.); vTipT = 0.;
  float cat = aMisc.x > 4.5 && aMisc.x < 5.5 ? 1. : 0., reed = aMisc.x > 5.5 && aMisc.x < 6.5 ? 1. : 0.;     // species 5 = cattail, 6 = reed
  bool pet = (part > .5 && part < 1.5) || (part > 5.5 && part < 6.5), plume = part > 6.5, bowl = (aMisc.x > .5 && aMisc.x < 1.5) || (aMisc.x > 2.5 && aMisc.x < 3.5);   // petal variant B for species 1 and 3
  vec2 leanDir = vec2(cos(yaw * 1.7 + 2.), sin(yaw * 1.7 + 2.)); float leanAmt = h * (.03 + .13 * fract(ph * 9.17)) * (1. + reed * .9);
  vec3 p;
  if(part < .5){ float t = position.y; p = stem(t, h, ph, aMisc.z, aMisc.x); p.xz += leanDir * leanAmt * t * t;
    float sw = h * .018 * (cat > .5 ? aColor.g : reed > .5 ? 1.2 : 1.); p.xz += rot2(vec2(position.x * sw, 0.), -yaw);
    vec3 green = mix(vec3(.17, .33, .08), vec3(.27, .45, .12), aMisc.y);
    if(reed > .5) green = mix(vec3(.36, .36, .17), vec3(.5, .5, .25), aMisc.y);                                           // tan-olive culms
    if(cat > .5) green = mix(vec3(.2, .34, .14), vec3(.3, .44, .2), aMisc.y);
    vCol3 = green * (.8 + .3 * t) * mix(.45, 1., smoothstep(0., .4, t)); vegNormal = vec3(0., 1., 0.); }
  else { vec3 a = stem(aAttach, h, ph, aMisc.z, aMisc.x); a.xz += leanDir * leanAmt * aAttach * aAttach;
    vec3 o = position * size; float open = (aMisc.w > 0. && cat < .5 && reed < .5) ? aMisc.w : 1.;
    if(pet && (part > 5.5) != bowl && aMisc.x < 4.5) o = vec3(0.);                                                     // show only this species' petal variant
    if(plume && aMisc.w < .35) o = vec3(0.);                                                                          // not every reed carries a seed head
    if(pet){ o.xz *= mix(.3, 1., open); o.y *= mix(1.6, 1., open); o.xz *= .92 + .16 * fract(ph * 13.1); }             // buds / half-open flowers, per-flower size jitter
    if(cat > .5 && part > 1.5 && part < 2.5){ o.y *= aColor.r; o.xz *= aMisc.w; }
    o.xz = rot2(o.xz, -yaw);
    if((pet || (part > 1.5 && part < 2.5)) && cat < .5){ float tilt = .1 + .5 * fract(ph * 5.3); o.xz += leanDir * (o.y * tilt); o.y *= cos(tilt); }   // heads nod, none face straight up
    p = a + o; vegNormal = normalize(vec3(0., 1., 0.) + vec3(o.x, 0., o.z) * .2 / max(size, 1e-4));
    if(pet){ float rr = length(position.xz); vec3 bc = aColor * (.88 + .22 * fract(ph * 7.7)); bc.g *= .94 + .1 * fract(ph * 3.3);   // each flower a little lighter / warmer than its neighbour
      float cup = bowl ? mix(.55, 1., smoothstep(.04, .55, rr)) : 1.;                                                     // cupped flowers: shaded inside, lit rim
      vCol3 = mix(bc * vec3(1.1, 1.08, .92) + vec3(.04, .035, .01), bc * .86, smoothstep(.08, .95, rr)) * cup * (.94 + .08 * sin(atan(position.z, position.x) * 13. + ph * 6.));   // light base -> deeper tips, soft value variation between petals
      vegNormal = normalize(vec3(0., 1., 0.) + vec3(o.x, 0., o.z) * .7 / max(size, 1e-4)); }
    else if(part > 1.5 && part < 2.5){ vec3 c0 = cat > .5 ? vec3(.3, .16, .07) * (.8 + .4 * aMisc.y) : (aMisc.x > 2.5 && aMisc.x < 3.5) ? vec3(.09, .06, .05) : vec3(.93, .72, .12);
      vCol3 = c0 * (.55 + .7 * smoothstep(.15, .38, position.y)); }                                                       // domed centre, darker where it meets the petals
    else if(plume){ vCol3 = mix(vec3(.3, .22, .2), vec3(.55, .45, .36), position.y / .3) * (.85 + .3 * aMisc.y); vTipT = .4; }
    else { vCol3 = reed > .5 ? mix(vec3(.3, .42, .14), vec3(.5, .56, .22), aMisc.y) * (.7 + .5 * position.y) : mix(vec3(.14, .3, .07), vec3(.26, .45, .12), aMisc.y) * (.7 + .5 * position.y); vTipT = .3; } }
  transformed = aOff + p; vWorld = transformed;
`;
const ROSETTE_VS = /* glsl */`                                          // low leaf rosettes (dandelion / plantain)
  float size = aParam.y * uHeight * .8 + aParam.y * .2, yaw = aParam.w, ph = aParam.z;
  vec3 o = position * size; float la = atan(position.z, position.x), lv = .6 + .6 * hash21(vec2(floor((la + 3.1416) * 1.27), ph * 37.));      // every leaf its own length
  o.xz *= lv * (.8 + .4 * hash21(vec2(ph * 11., 5.))); o.xz = rot2(o.xz, -yaw);
  float amp = gAmp(aOff.xz, ph); vec2 d = uWindDir * amp * .12 * (position.y + length(position.xz) * .4) * size; o.xz += d;
  for(int i = 0; i < 6; i++){ vec4 b = uBodies[i]; if(b.w <= 0.) continue; vec2 bd = aOff.xz - b.xy; float br = length(bd), pu = (1. - smoothstep(0., b.z, br)) * b.w; o.xz += (br > .001 ? bd / br : vec2(0.)) * pu * size * .5; }
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
  transformed = aOff + o; vWorld = transformed; vLeaf = 1.; vLeafUv = position.xz * .5 + .5; vPh = ph; vTipT = .2; vCol3 = aColor;
  vegNormal = normalize(vec3(0., 1., 0.) + vec3(sin(spin), 0., cos(spin)) * .12);
`;
const PAD_VS = /* glsl */`                                              // lily pads: irregular outline, float with the water, bob with the shared wind
  float size = aParam.y, yaw = aParam.w, ph = aParam.z, rr = length(position.xz), ang = atan(position.z, position.x);
  float shape = 1. + .08 * sin(ang * 3. + ph * 6.28) + .05 * sin(ang * 5. + ph * 17.) + .03 * sin(ang * 9. + ph * 31.);      // no two outlines alike
  vec3 o = vec3(position.x, 0., position.z) * size * shape; o.xz = rot2(o.xz, -yaw);
  float calm = .35 + .65 * min(1., uWind);
  o.y += (rr * rr * .07 + .012) * size * (.7 + .6 * fract(ph * 5.3)) + sin(uTime * .8 + ph * 1.5) * uSpan * .0004 * calm + sin(uTime * 1.3 + ph * 2.) * uSpan * .0002 * rr * calm + (fract(ph * 7.7) - .5) * uSpan * .002;
  transformed = aOff + o; vWorld = transformed; vLeaf = 2.; vLeafUv = position.xz; vPh = ph; vTipT = .25;
  float old = aMisc.y;                                                     // older pads yellow / brown a little
  vCol3 = mix(vec3(.08, .24, .06), vec3(.2, .42, .1), rr) * aColor.r * mix(vec3(1.), vec3(1.5, 1.25, .6), old * old) * (.92 + .1 * sin(ang * 14.));
  vegNormal = vec3(0., 1., 0.);
`;
const FALL_VS = /* glsl */`                                             // leaves in the air: fall, drift with the wind, tumble; wrap around the model
  float size = aParam.y, ph = aParam.z, box = uSpan * 5.;
  float tt = uTime * (.25 + ph * .2) + aParam.w * 7.;
  vec2 xz = uBodies[0].xy + (fract(aOff.xz / box + uWindDir * uTime * uSpan * .06 / box * (.6 + ph) + .5) - .5) * box;
  float top = uSpan * 1.8, y = top - fract(aOff.y + uTime * (.035 + .03 * ph) * uSpan * .5 / top) * top;
  xz += vec2(sin(tt * 1.7 + ph * 9.), cos(tt * 1.3 + ph * 5.)) * uSpan * .08;
  vec3 o = vec3(position.x, 0., position.z) * size;
  float a1 = tt * 2.1 + ph * 6., a2 = tt * 1.6; o.xy = rot2(o.xy, sin(a1) * 1.1); o.yz = rot2(o.yz, sin(a2) * 1.0); o.xz = rot2(o.xz, tt);
  transformed = vec3(xz.x, ${'GROUND_Y'} + y, xz.y) + o; vWorld = transformed; vLeaf = 1.; vLeafUv = position.xz * .5 + .5; vPh = ph; vTipT = .4; vCol3 = aColor;
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

export const MEADOW_DEFAULTS = {pond: 70, height: 50, density: 70, wind: 45, speed: 50, gust: 35, dir: 35, dry: 25, rough: 35, sun: 42, flowers: 70, weeds: 70, leaves: 60, fall: 60, clouds: 45, weather: 0, season: 33};

// ---------------------------------------------------------------- geometries (all "unit" sized; per-instance attributes scale them)
function geo(parts){                                               // parts: [{pos[], idx[], part, attach[]}] -> one indexed BufferGeometry
  const pos = [], part = [], att = [], idx = []; let base = 0;
  for(const g of parts){ for(let i = 0; i < g.pos.length; i += 3){ pos.push(g.pos[i], g.pos[i + 1], g.pos[i + 2]); part.push(g.part); att.push(g.attach ? g.attach[i / 3] : g.pos[i + 1]); }
    for(const i of g.idx) idx.push(base + i); base += g.pos.length / 3; }
  const b = new THREE.BufferGeometry(); b.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); b.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  b.setAttribute('aAttach', new THREE.Float32BufferAttribute(att, 1)); b.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => i % 3 === 1 ? 1 : 0), 3));   // (newer three switches to flat shading when there is no normal attribute)
  b.setIndex(idx); return b;
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

// One curved, cupped petal: base at the origin, pointing +x, lifted by `elev`, twisted by `roll`, swung round the stem by `theta`.
function petal(L, W, curl, droop, elev, theta, roll, rows = 3){
  const pos = [], idx = [], v = new THREE.Vector3(), m = new THREE.Matrix4().makeRotationY(theta).multiply(new THREE.Matrix4().makeRotationX(roll)).multiply(new THREE.Matrix4().makeRotationZ(elev));
  for(let i = 0; i <= rows; i++){ const u = i / rows, w = W * Math.sin(Math.PI * Math.pow(u, .65)) * .5 + (i === rows ? 0 : .0005), x = L * u, y = (curl * Math.sin(u * 1.7) - droop * u * u) * L, cup = .45 * w * (1 - u * .5);
    for(const [dz, dy] of [[-w, 0], [0, cup], [w, 0]]){ v.set(x, y + dy, dz).applyMatrix4(m); pos.push(v.x, v.y, v.z); } }
  for(let i = 0; i < rows; i++){ const a = i * 3, b = a + 3; idx.push(a, a + 1, b, a + 1, b + 1, b, a + 1, a + 2, b + 1, a + 2, b + 2, b + 1); }
  return {pos, idx};
}
function petalSet(specs, seed){                                          // overlapping rings of petals with fixed irregular angles / lengths
  const r = mulberry(seed), pos = [], idx = [];
  for(const [n, L, W, curl, droop, elev, off] of specs) for(let i = 0; i < n; i++){
    const p = petal(L * (.88 + .24 * r()), W * (.85 + .3 * r()), curl, droop * (.7 + .6 * r()), elev + (r() - .5) * .18, off + i / n * Math.PI * 2 + (r() - .5) * .45, (r() - .5) * .5);
    const b = pos.length / 3; pos.push(...p.pos); for(const k of p.idx) idx.push(b + k); }
  return {pos, idx};
}
export function createMeadow({scene, span, center, seed = '1', params = {}, wind = new WindSystem()}){
  const P = {...MEADOW_DEFAULTS, ...params}, group = new THREE.Group(), cs = span * .75, K = 3, KI = 2, y0 = center.y;
  const noise = new Noise(hashStr(seed)), moist = new Noise(hashStr(seed + 'm')), patch = new Noise(hashStr(seed + 'p')), clear = new Noise(hashStr(seed + 'c')), flo = new Noise(hashStr(seed + 'f'));
  group.name = 'meadow';

  // ---- terrain
  const amp = () => span * .09 * P.rough / 100;
  const prn = mulberry(hashStr(seed + 'pond')), pa = Math.PI + (prn() - .5) * 1.4;           // a natural pond, behind the model on a seeded side
  const pond = {cx: center.x + Math.sin(pa) * span * 2.15, cz: center.z + Math.cos(pa) * span * 2.15, R: span * (.85 + prn() * .25), wl: y0 - span * .03, depth: span * .16, p1: prn() * 6.28, p2: prn() * 6.28};
  const pondD = (x, z) => { const dx = x - pond.cx, dz = z - pond.cz, a = Math.atan2(dz, dx); return Math.hypot(dx, dz) / (pond.R * (1 + .16 * Math.sin(3 * a + pond.p1) + .09 * Math.sin(5 * a + pond.p2))); };   // <1 inside, irregular outline
  const land = (x, z) => { const r = Math.hypot(x - center.x, z - center.z), flat = smooth(span * .3, span * 1.1, r);
    return y0 + (noise.fbm(x / span * .9, z / span * .9) - .5) * 2 * amp() * flat + (noise.fbm(x / span * .25 + 9, z / span * .25) - .4) * span * .5 * smooth(span * 4, span * 9, r); };
  const height = (x, z) => { const h = land(x, z), d = pondD(x, z); if(d > 1.5) return h; return h - pond.depth * Math.pow(1 - smooth(.15, 1.5, d), 1.6); };       // bowl-shaped basin
  const wet = (x, z) => clamp(moist.fbm(x / span * .7 + 3, z / span * .7 - 5) * 1.5 - .15, 0, 1);
  const waterDepth = (x, z) => pond.wl - height(x, z);                       // + below the surface, - above it (world units): the single source of truth for the shoreline
  const bare = (x, z) => 1 - smooth(.3, .56, clear.fbm(x / span * 1.4 + 11, z / span * 1.4 - 3));           // 1 = bare soil patch (clearing)
  const dense = (x, z) => smooth(.32, .58, patch.fbm(x / span * 1.05 + 30, z / span * .95 - 17));              // 0 sparse .. 1 dense: grass comes in patches
  const T = span * 12, SEG = 300, tg = new THREE.PlaneGeometry(T * 2, T * 2, SEG, SEG); tg.rotateX(-Math.PI / 2);
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
    uSeason: {value: 1}, uWet: {value: 0}, uWL: {value: pond.wl}, uRain: {value: 0}, uCamPos: {value: new THREE.Vector3()}, uBodies: {value: Array.from({length: 6}, (_, i) => i ? new THREE.Vector4(0, 0, 1, 0) : new THREE.Vector4(center.x, center.z, span * .2, 1))}, uSunW: {value: sunDir}, uSunCol: {value: new THREE.Vector3()}, uCover: {value: .45},
  };
  const terrainMat = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 1});
  terrainMat.onBeforeCompile = sh => {                                // ground gets the same moving cloud shadows
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWorldT;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorldT = (modelMatrix * vec4(transformed, 1.)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWorldT; uniform vec3 uSunW; uniform float uSeason, uWet, uWL;\n' + NOISE_GLSL + CLOUD_GLSL)
      .replace('#include <color_fragment>', `#include <color_fragment>
      { // ground detail: moss carpets on the damp green parts, soil crumbs, pebbles, leaf litter specks
        vec2 q = vWorldT.xz / uSpan;
        float fine = fbm4(q * 38.), mid = fbm4(q * 9. + 3.), crumb = hash21(floor(q * 320.)), peb = hash21(floor(q * 140.) + 7.);
        float green = clamp((diffuseColor.g - diffuseColor.r) * 7., 0., 1.);
        float moss = smoothstep(.42, .66, fbm4(q * 2.4 + 17.)) * green;
        vec3 mossCol = pow(mix(vec3(.09, .2, .05), vec3(.26, .43, .11), fine) * (.8 + .4 * crumb), vec3(2.2));
        diffuseColor.rgb *= .72 + .56 * mid;
        diffuseColor.rgb = mix(diffuseColor.rgb, mossCol, moss * .85);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.07, .065, .055), step(.992, peb) * smoothstep(.42, .2, length(fract(q * 140.) - .5)) * (1. - moss));       // round pebbles, not squares
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.2, .12, .05), step(.97, crumb) * smoothstep(.45, .2, length(fract(q * 320.) - .5)) * .5 * (1. - moss));
        float win = smoothstep(2.4, 3., uSeason), aut = smoothstep(1.2, 2., uSeason) * (1. - smoothstep(2.6, 3., uSeason));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.25, .95, .6), aut * .5);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.75, .8, .85), win * (.5 + .4 * fine));                     // frost / thin snow
        diffuseColor.rgb *= 1. - .32 * uWet;                                                                   // wet ground is darker
        // shoreline zones from the REAL height above the water line: dry bank -> damp soil -> mud -> submerged bed (irregular edges, no hard outline)
        float dh = (vWorldT.y - uWL) / uSpan + (fbm4(q * 6. + 3.) - .5) * .02 + (fbm4(q * 26.) - .5) * .006;
        float damp = smoothstep(.07, .02, dh), mudz = smoothstep(.022, -.004, dh), bed = smoothstep(.0, -.012, dh);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(.55, .48, .42), damp * .8);                // wet, darker soil
        diffuseColor.rgb = mix(diffuseColor.rgb, pow(vec3(.2, .15, .1) * (.8 + .4 * fine), vec3(2.2)), mudz * (1. - .5 * moss));
        diffuseColor.rgb = mix(diffuseColor.rgb, pow(vec3(.17, .17, .12) * (.75 + .5 * mid), vec3(2.2)), bed);       // silty bed seen through shallow water
        float stoneBand = smoothstep(-.03, -.005, dh) * smoothstep(.06, .01, dh);
        float stone = step(.955, hash21(floor(q * 210.) + 3.)) * stoneBand * smoothstep(.45, .22, length(fract(q * 210.) - .5)); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.09, .085, .075) * (.7 + .6 * hash21(floor(q * 210.))), stone);   // small stones
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.2 + .02, step(.99, hash21(floor(q * 330.) + 9.)) * smoothstep(.45, .2, length(fract(q * 330.) - .5)) * damp * .5);   // wet shine specks
      }
      diffuseColor.rgb *= 1. - .5 * cloudDensity(vWorldT.xz + uSunW.xz / max(uSunW.y, .1) * uSpan * ${CLOUD_Y}.);`);
  };
  const terrain = new THREE.Mesh(tg, terrainMat); terrain.receiveShadow = true; terrain.matrixAutoUpdate = false; group.add(terrain);

  // ---- vegetation kinds
  function bladeProfile(rows, taper){                                // 3 verts per row (left, midrib pushed back, right) + tip: lit/shaded halves, like a folded leaf
  const pos = [], idx = [];
  for(let i = 0; i < rows; i++){ const t = i / rows, hw = .5 * (1 - Math.pow(t, 1.5) * taper); pos.push(-hw, t, 0, 0, t, -hw * .5, hw, t, 0); }
  pos.push(0, 1, -.02);
  for(let i = 0; i < rows - 1; i++){ const a = i * 3, b = a + 3; idx.push(a, a + 1, b, a + 1, b + 1, b, a + 1, a + 2, b + 1, a + 2, b + 2, b + 1); }
  const a = (rows - 1) * 3, tip = rows * 3; idx.push(a, a + 1, tip, a + 1, a + 2, tip);
  return {pos, idx};
}
const grassGeo = geo([{...bladeProfile(5, .92), part: 0}]);
  // flower heads: two petal variants sharing one geometry (the shader shows one by species) + a domed centre.
  //   A: many narrow, slightly drooping petals in two overlapping rings (daisy / aster)   B: five broad cupped petals + an inner ring (buttercup / poppy)
  const flA = petalSet([[13, 1, .2, .06, .14, .12, 0], [8, .68, .2, .08, .1, .34, .2]], 11), flB = petalSet([[5, 1, .95, .3, .16, .62, 0], [5, .72, .72, .26, .1, .98, .63]], 23);
  const cpos = [0, .38, 0], cidx = []; for(let ring = 0; ring < 2; ring++) for(let i = 0; i < 9; i++){ const a = i / 9 * Math.PI * 2, rr = ring ? .11 : .22; cpos.push(Math.cos(a) * rr, ring ? .31 : .18, Math.sin(a) * rr); }
  for(let i = 0; i < 9; i++){ const j = (i + 1) % 9; cidx.push(1 + 9 + i, 1 + 9 + j, 0, 1 + i, 1 + j, 1 + 9 + i, 1 + j, 1 + 9 + j, 1 + 9 + i); }
  const headParts = [{pos: flA.pos, idx: flA.idx, part: 1, attach: Array(flA.pos.length / 3).fill(1)}, {pos: flB.pos, idx: flB.idx, part: 6, attach: Array(flB.pos.length / 3).fill(1)}, {pos: cpos, idx: cidx, part: 2, attach: Array(cpos.length / 3).fill(1)}];
  const flowerGeo = geo([{...ribbon(4, .1, 1), part: 0}, ...headParts]);
  const dockParts = [{...ribbon(4, .2, 1), part: 0}];
  [[.3, 0], [.5, 2.1], [.7, 4.2]].forEach(([t, a]) => { const l = leafBlade(1, .5, .25, a, 0, 3); dockParts.push({...l, part: 3, attach: Array(l.pos.length / 3).fill(t)}); });
  const dockGeo = geo(dockParts);
  const rosParts = []; for(let i = 0; i < 8; i++) rosParts.push({...leafBlade(1, .38, .35, i / 8 * Math.PI * 2 + .2, 0, 3), part: 3});
  const rosGeo = geo(rosParts);
  const leafQuad = geo([{pos: [-1, 0, -1, 1, 0, -1, -1, 0, 1, 1, 0, 1], idx: [0, 1, 2, 1, 3, 2], part: 4}]);

  const grassMat = vegMaterial(U, GRASS_VS, 'grass'), plantMat = vegMaterial(U, PLANT_VS, 'plant'), rosMat = vegMaterial(U, ROSETTE_VS, 'rosette'), leafMat = vegMaterial(U, LEAF_VS, 'leaf');
  const fallMat = vegMaterial(U, FALL_VS.replace('GROUND_Y', y0.toFixed(4)), 'fall');
  
  const FL = [[.95, .93, .88], [.94, .7, .1], [.54, .34, .68], [.76, .11, .08], [.86, .52, .66]];           // daisy, buttercup, vetch, poppy, pink clover
  const AUT = [[.55, .3, .1], [.7, .5, .12], [.45, .25, .08], [.6, .55, .2], [.38, .3, .1]];             // leaf browns / ochres
  const kinds = {grass: {geo: grassGeo, mat: grassMat, N: 2700, R: K}, flowers: {geo: flowerGeo, mat: plantMat, N: 110, R: KI}, docks: {geo: dockGeo, mat: plantMat, N: 4, R: KI},
    weeds: {geo: rosGeo, mat: rosMat, N: 14, R: KI}, leaves: {geo: leafQuad, mat: leafMat, N: 55, R: KI}};
  const chunks = [], H = [.034, .066, .14], WR = [.085, .07, .06], FLEX = [.8, .9, 1];     // blade width is a fraction of its height
  const slopeAt = (x, z, y) => Math.hypot(height(x + span * .02, z) - y, height(x, z + span * .02) - y) / (span * .02);
  const make = (kind, ix, iz, x0, z0, build) => {
    const k = kinds[kind], rng = mulberry(hashStr(`${seed}:${kind}:${ix}:${iz}`)), sx = rng(), sz = rng();
    const off = new Float32Array(k.N * 3), prm = new Float32Array(k.N * 4), msc = new Float32Array(k.N * 4), clr = new Float32Array(k.N * 3); let n = 0;
    const pt = i => [x0 + ((halton(i, 2) + sx) % 1) * cs, z0 + ((halton(i, 3) + sz) % 1) * cs];
    const put = (x, z, y, p, m, cl) => { off.set([x, y, z], n * 3); prm.set(p, n * 4); msc.set(m, n * 4); if(cl) clr.set(cl, n * 3); n++; };
    build({rng, pt, put, count: () => n, N: k.N});
    const g = new THREE.InstancedBufferGeometry(); g.index = k.geo.index; for(const a of ['position', 'normal', 'aPart', 'aAttach']) g.setAttribute(a, k.geo.attributes[a]);
    g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off.subarray(0, n * 3), 3)); g.setAttribute('aParam', new THREE.InstancedBufferAttribute(prm.subarray(0, n * 4), 4));
    g.setAttribute('aMisc', new THREE.InstancedBufferAttribute(msc.subarray(0, n * 4), 4)); g.setAttribute('aColor', new THREE.InstancedBufferAttribute(clr.subarray(0, n * 3), 3));
    g.instanceCount = n; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(x0 + cs / 2, y0, z0 + cs / 2), cs * .75 + span * .4);
    const mesh = new THREE.Mesh(g, k.mat); mesh.receiveShadow = true; mesh.userData = {full: n, c: g.boundingSphere.center, kind}; group.add(mesh); chunks.push(mesh);
  };
  for(let ix = -K; ix <= K; ix++) for(let iz = -K; iz <= K; iz++){
    const x0 = center.x + (ix - .5) * cs, z0 = center.z + (iz - .5) * cs, inner = Math.abs(ix) <= KI && Math.abs(iz) <= KI;
    const ok = (x, z, rng, p, sub) => {                                           // bank-aware: thinner towards the water, nothing in it (except a little submerged grass)
      if(Math.hypot(x - center.x, z - center.z) < span * .05) return false;
      const above = -waterDepth(x, z) / span;
      if(above < 0) return !!sub && above > -.012 && rng() < p * .12;
      return rng() < p * (.12 + .88 * smooth(.0, .06, above));
    };
    // grass: clumps ("tufts") with a loose scatter between them; thinner on slopes, dry ground and in clearings
    make('grass', ix, iz, x0, z0, ({rng, pt, put, count, N}) => {
      for(let i = 1; i < N * 3 && count() < N; i++){
        const [cx, cz] = pt(i), cy = height(cx, cz), m = wet(cx, cz), b = bare(cx, cz), sl = slopeAt(cx, cz, cy);
        const dn = dense(cx, cz);
        if(!ok(cx, cz, rng, clamp(1 - sl * 1.6, 0, 1) * (.3 + .7 * m) * (1 - .95 * b) * (.1 + .9 * dn), true)) continue;       // dense patch -> sparse -> bare soil -> dense
        const pn = patch.fbm(cx / span * 2.4, cz / span * 2.4), sp = pn > .74 ? 2 : pn > .52 ? 1 : 0, tuft = rng() < .5 ? 4 + ((rng() * 5) | 0) : 1;
        for(let j = 0; j < tuft && count() < N; j++){
          const a = rng() * 6.2832, r = tuft > 1 ? span * .016 * Math.sqrt(rng()) : 0, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r, y = height(x, z);
          const hh = span * H[sp] * (.6 + .8 * rng() * rng() + (rng() < .06 ? .9 : 0)) * (sp === 2 ? .8 + m * .5 : 1) * (tuft > 1 ? 1 : .8);   // mostly short, a few tall blades
          put(x, z, y, [hh, hh * WR[sp] * (.8 + .4 * rng()), rng(), rng() * 6.2832], [sp, clamp(rng() * .55 + pn * .55 - .15, 0, 1), FLEX[sp], rng() * .5 + (1 - m) * .5]);
        }
      } });
    if(!inner) continue;
    // wildflowers: in patches, species chosen by a second noise field
    make('flowers', ix, iz, x0, z0, ({rng, put, count, N}) => {                    // a few small clusters per chunk (many chunks have none); species per cluster with a few strays
      let made = 0; const want = 1 + ((rng() * 3) | 0);
      for(let t = 0; t < 40 && made < want && count() < N; t++){
        const cx = x0 + rng() * cs, cz = z0 + rng() * cs; if(flo.fbm(cx / span * 1.4 + 5, cz / span * 1.4) < .55) continue;
        made++; const base = (rng() * 5) | 0, hmul = .7 + .6 * rng(), R = span * (.05 + .13 * rng()), n = 4 + ((Math.pow(rng(), 1.7) * 20) | 0), tilt = rng();
        for(let j = 0; j < n && count() < N; j++){
          const a = rng() * 6.2832, r = R * Math.pow(rng(), .75), x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r; if(!ok(x, z, rng, 1 - .9 * bare(x, z))) continue;
          const sp = rng() < .82 ? base : (rng() * 5) | 0, cl = FL[sp].map(v => clamp(v * (.88 + .24 * rng()), 0, 1)), big = rng() < .1 ? 1.5 : 1;
          const k = rng(), open = k < .1 ? .22 : k < .22 ? .55 : 1;                                       // a few buds and half-open flowers
          put(x, z, height(x, z), [span * (.04 + .06 * rng() * rng() + .015 * tilt) * hmul * big, span * (.011 + .011 * rng()) * big, rng(), rng() * 6.2832], [sp, rng(), .8, open], cl);
        } } });
    make('docks', ix, iz, x0, z0, ({rng, pt, put, count, N}) => {
      for(let i = 1; i < N * 8 && count() < N; i++){ const [x, z] = pt(i); if(!ok(x, z, rng, .08 * (1 - bare(x, z)))) continue; const y = height(x, z);
        put(x, z, y, [span * (.12 + .09 * rng()), span * (.05 + .03 * rng()), rng(), rng() * 6.2832], [9, rng(), .45, 0]); } });
    make('weeds', ix, iz, x0, z0, ({rng, pt, put, count, N}) => {
      for(let i = 1; i < N * 5 && count() < N; i++){ const [x, z] = pt(i), m = wet(x, z); if(flo.fbm(x / span * 2.2 + 80, z / span * 2.2) < .56 || !ok(x, z, rng, (.25 + .6 * (1 - Math.abs(m - .5) * 2)) * (1 - .6 * bare(x, z)))) continue;
        put(x, z, height(x, z), [1, span * (.025 + .025 * rng()), rng(), rng() * 6.2832], [9, rng(), .3, 0]); } });
    make('leaves', ix, iz, x0, z0, ({rng, pt, put, count, N}) => {
      for(let i = 1; i < N * 3 && count() < N; i++){ const [x, z] = pt(i); if(clear.fbm(x / span * 2. + 50, z / span * 2.) < .52 || !ok(x, z, rng, .8)) continue; const a = AUT[(rng() * AUT.length) | 0], f = .8 + .4 * rng();
        put(x, z, height(x, z), [1, span * (.008 + .008 * rng()), rng(), rng() * 6.2832], [9, rng(), .3, 0], a.map(v => clamp(v * f, 0, 1))); } });
  }
  // drifting leaves: one draw call, positions fully animated on the GPU
  { const N = 90, rng = mulberry(hashStr(seed + 'fall')), off = new Float32Array(N * 3), prm = new Float32Array(N * 4), msc = new Float32Array(N * 4), clr = new Float32Array(N * 3);
    for(let i = 0; i < N; i++){ off.set([rng() * 1e3, rng(), rng() * 1e3], i * 3); prm.set([1, span * (.01 + .008 * rng()), rng(), rng()], i * 4); const a = AUT[(rng() * AUT.length) | 0]; clr.set(a, i * 3); }
    const g = new THREE.InstancedBufferGeometry(); g.index = leafQuad.index; for(const a of ['position', 'normal', 'aPart', 'aAttach']) g.setAttribute(a, leafQuad.attributes[a]);
    g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 3)); g.setAttribute('aParam', new THREE.InstancedBufferAttribute(prm, 4)); g.setAttribute('aMisc', new THREE.InstancedBufferAttribute(msc, 4)); g.setAttribute('aColor', new THREE.InstancedBufferAttribute(clr, 3));
    g.instanceCount = N; const mesh = new THREE.Mesh(g, fallMat); mesh.frustumCulled = false; mesh.userData = {full: N, kind: 'fall'}; group.add(mesh); chunks.push(mesh); }

  // ---- rain, anime style: hair-thin tapered streaks (blue tail -> white head, hard-edged alpha bands), plus cel-shaded
  //      ripple rings and impact flashes where drops hit the ground.
  const RN = 3600, rg = new THREE.InstancedBufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute([-.5, 0, 0, .5, 0, 0, -.5, 1, 0, .5, 1, 0], 3)); rg.setIndex([0, 1, 2, 1, 3, 2]);
  { const o = new Float32Array(RN * 3), r = mulberry(hashStr(seed + 'rain')); for(let i = 0; i < RN; i++) o.set([r(), r(), r()], i * 3); rg.setAttribute('aSeed', new THREE.InstancedBufferAttribute(o, 3)); rg.instanceCount = RN; }
  const rain = new THREE.Mesh(rg, new THREE.ShaderMaterial({uniforms: {uTime: U.uTime, uSpan: U.uSpan, uRain: U.uRain, uCam: U.uCamPos, uWindDir: U.uWindDir}, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: `attribute vec3 aSeed; uniform float uTime, uSpan, uRain; uniform vec3 uCam; uniform vec2 uWindDir; varying float vA; varying vec2 vUv;
      void main(){ float B = uSpan * 3.5, H = uSpan * 2.2, sz = .55 + fract(aSeed.x * 57.3 + aSeed.z * 13.1) * .9;          // a few drops are bigger / nearer-feeling
        vec3 base = vec3((aSeed.x - .5) * B, 0., (aSeed.z - .5) * B);
        float y = fract(aSeed.y - uTime * (1.5 + aSeed.x * .6)) * H; vec3 wp = uCam + base; wp.xz += uWindDir * y * .3; wp.y = uCam.y - H * .4 + y;
        vec4 mv = viewMatrix * vec4(wp, 1.); vec3 dirV = normalize((viewMatrix * vec4(uWindDir.x * .3, 1., uWindDir.y * .3, 0.)).xyz);   // streak follows the wind slant
        float tw = .25 + .75 * position.y;                                                                                      // taper: thin tail, fuller head
        mv.xyz += vec3(position.x * uSpan * .0016 * tw * sz, 0., 0.) + dirV * position.y * uSpan * .085 * sz;
        vA = uRain * (.35 + .5 * fract(aSeed.x * 91.7)) * (1. - smoothstep(B * .3, B * .5, length(base.xz))); vUv = vec2(position.x + .5, position.y);
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying float vA; varying vec2 vUv;
      void main(){ float across = 1. - abs(vUv.x - .5) * 2., t = vUv.y;
        float a = vA * smoothstep(0., .35, across) * smoothstep(0., .75, t);
        a = floor(a * 4. + .5) / 4.;                                                      // cel bands: hard-edged, no soft airbrushing
        if(a < .05) discard;
        vec3 col = mix(vec3(.42, .68, .95), vec3(.82, .93, 1.), smoothstep(.55, 1., t));    // translucent blue tail -> pale head (never pure white)
        gl_FragColor = vec4(col, a * .75); }`}));
  rain.frustumCulled = false; rain.visible = false; group.add(rain);
  const SN = 900, sg = new THREE.InstancedBufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3)); sg.setIndex([0, 1, 2, 1, 3, 2]);
  { const pos = new Float32Array(SN * 3), sd = new Float32Array(SN * 3), r = mulberry(hashStr(seed + 'splash'));
    for(let i = 0; i < SN; i++){ const a = r() * 6.2832, d = Math.sqrt(r()) * span * 3.4, x = center.x + Math.cos(a) * d, z = center.z + Math.sin(a) * d; if(pondD(x, z) < 1.1){ i--; continue; } pos.set([x, height(x, z), z], i * 3); sd.set([r(), .7 + r() * .9, r()], i * 3); }
    sg.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos, 3)); sg.setAttribute('aSd', new THREE.InstancedBufferAttribute(sd, 3)); sg.instanceCount = SN; }
  // ground splashes are NOT rings (rings are for water): a short spray star + a brief dark wet spot that soaks in
  const splash = new THREE.Mesh(sg, new THREE.ShaderMaterial({uniforms: {uTime: U.uTime, uSpan: U.uSpan, uRain: U.uRain}, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: `attribute vec3 aPos; attribute vec3 aSd; uniform float uTime, uSpan; varying vec2 vUv; varying float vT, vS;
      void main(){ float life = 1.1 + aSd.y * .9, t = fract((uTime + aSd.x * 11.) / life); vT = t; vUv = position.xy; vS = aSd.z * 6.2832;
        float R = uSpan * (.008 + .008 * aSd.z) * (.6 + .4 * t) * 1.7;
        vec3 w = aPos + vec3(position.x * R, uSpan * .02, position.y * R * .85);
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.); }`,
    fragmentShader: `uniform float uRain; varying vec2 vUv; varying float vT, vS;
      void main(){ float r = length(vUv), ang = atan(vUv.y, vUv.x) + vS;
        float spokes = pow(abs(sin(ang * 3.5)), 5.), burst = smoothstep(.45, .0, abs(r - (.15 + vT * .5))) * spokes * (1. - smoothstep(.0, .35, vT));      // quick spray, then gone
        float spot = smoothstep(.75, .25, r) * (1. - smoothstep(.2, 1., vT)) * .5;                                                                     // wet spot soaking in
        float a = max(burst, spot * .55) * uRain; if(a < .04) discard;
        vec3 col = burst > spot * .55 ? vec3(.62, .8, .95) : vec3(.12, .17, .2);
        gl_FragColor = vec4(col, a * (burst > spot * .55 ? .7 : .45)); }`}));
  splash.frustumCulled = false; splash.visible = false; group.add(splash);

  // ---- sky dome (follows the camera) with clouds
  const skyU = {uSun: {value: sunDir}, uSunCol: {value: U.uSunCol.value}, uHorizon: {value: new THREE.Vector3()}, uZenith: {value: new THREE.Vector3()}, uCam: {value: new THREE.Vector3()}, uCloudCol: {value: new THREE.Vector3(.97, .97, .98)},
    uTime: U.uTime, uCover: U.uCover, uSpan: U.uSpan, uSpeed: U.uSpeed, uWindDir: U.uWindDir};
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20), new THREE.ShaderMaterial({vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, depthTest: false, uniforms: skyU}));
  dome.renderOrder = -10; dome.frustumCulled = false; group.add(dome);
  // ---- pond water. Depth comes from the real terrain (baked into a texture): clear in the shallows, progressively more opaque and
  //      darker with depth, so the bed shows through near the bank and there is no hard edge. Surface: low-frequency wind-driven waves
  //      (the shared wind), raindrop ripples with random size / lifetime / start time, Fresnel reflection (strong only at grazing angles).
  const DN = 160, half = pond.R * 1.9, dd = new Uint8Array(DN * DN * 4);
  for(let j = 0; j < DN; j++) for(let i = 0; i < DN; i++){ const x = pond.cx + ((i + .5) / DN * 2 - 1) * half, z = pond.cz + ((j + .5) / DN * 2 - 1) * half, d = clamp(waterDepth(x, z) / pond.depth, 0, 1); dd.set([d * 255, 0, 0, 255], (j * DN + i) * 4); }
  const depthTex = new THREE.DataTexture(dd, DN, DN, THREE.RGBAFormat); depthTex.magFilter = depthTex.minFilter = THREE.LinearFilter; depthTex.needsUpdate = true;
  const waterU = {uTime: U.uTime, uSpan: U.uSpan, uRain: U.uRain, uWind: U.uWind, uSpeed: U.uSpeed, uWindDir: U.uWindDir, uCam: U.uCamPos, uSun: skyU.uSun, uSunCol: skyU.uSunCol, uHorizon: skyU.uHorizon, uZenith: skyU.uZenith,
    uDepth: {value: depthTex}, uBox: {value: new THREE.Vector3(pond.cx, pond.cz, half)}, uMaxD: {value: pond.depth}, uFog: {value: new THREE.Vector2(1, 2)}};
  const water = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({uniforms: waterU, transparent: true, depthWrite: false,
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform float uTime, uSpan, uRain, uMaxD, uWind, uSpeed; uniform vec2 uWindDir, uFog; uniform vec3 uCam, uSun, uSunCol, uHorizon, uZenith, uBox; uniform sampler2D uDepth; varying vec3 vW;
      float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
      // raindrop ripples: a drop per jittered cell; each has its own start time, lifetime, final radius, strength and slight ellipse/wobble
      float ringH(vec2 p, float scale, float act){
        vec2 q = p / (uSpan * scale), cell = floor(q), f = fract(q); float s = 0.;
        for(int j = -1; j <= 1; j++) for(int i = -1; i <= 1; i++){
          vec2 id = cell + vec2(float(i), float(j)); float a = h21(id), b = h21(id + 17.3), c = h21(id + 5.1), d = h21(id + 29.7); if(a > act) continue;
          float life = 1.2 + 1.8 * c, t = fract((uTime + b * 13.) / life), maxR = .18 + .3 * d;                    // keep the final radius under half a cell so rings never get clipped into squares
          vec2 off = vec2(float(i), float(j)) + vec2(b, c) * .7 + .15 - f; off.x *= 1. + .2 * (d - .5);
          float r = length(off), R = t * maxR + .03 * sin(atan(off.y, off.x) * 4. + b * 20.), w = mix(.045, .12, t), amp = (1. - t) * (1. - t) * (.35 + .9 * d);
          s += (exp(-pow((r - R) / w, 2.)) - .45 * exp(-pow((r - R * .62) / (w * 1.3), 2.))) * amp; }
        return s; }
      float rip(vec2 p){ float act = clamp(uRain * .85 + .05, 0., 1.); return ringH(p, .12, act) + ringH(p + 7.3, .07, act * .55); }
      void main(){
        vec2 uv = (vW.xz - uBox.xy) / (uBox.z * 2.) + .5; float dn = texture2D(uDepth, uv).r, dm = dn * uMaxD;
        vec2 p = vW.xz; float e = uSpan * .003, h0 = rip(p), hx = rip(p + vec2(e, 0.)), hz = rip(p + vec2(0., e));
        // wind waves: two crossing trains along the shared wind, amplitude from wind strength, plus slow breakup
        float A = .002 + .006 * uWind, k1 = 6.2832 / (uSpan * .7), k2 = 6.2832 / (uSpan * .33);
        vec2 w1 = uWindDir, w2 = normalize(uWindDir + vec2(-uWindDir.y, uWindDir.x) * .6);
        vec2 slope = w1 * cos(dot(p, w1) * k1 - uTime * uSpeed * .85) * k1 * A * uSpan + w2 * cos(dot(p, w2) * k2 - uTime * uSpeed * 1.25) * k2 * A * .5 * uSpan
                   + (vec2(vn(p / uSpan * 3. + uTime * .05), vn(p / uSpan * 3. - uTime * .04 + 9.)) - .5) * (.008 + .02 * uWind);
        vec3 n = normalize(vec3((hx - h0) * 8. - slope.x, 1., (hz - h0) * 8. - slope.y));      // slopes of waves + ripples, y = 1
        vec3 V = normalize(uCam - vW), R = reflect(-V, n);
        vec3 sky = mix(uHorizon, uZenith, pow(clamp(R.y, 0., 1.), .55)) * vec3(.92, .96, 1.);
        float fres = .02 + .98 * pow(1. - max(dot(n, V), 0.), 5.);                                           // Schlick: strong only at grazing angles
        vec3 scat = mix(vec3(.13, .27, .2), vec3(.02, .1, .14), smoothstep(0., .9, dn)) * (.85 + .3 * vn(p / uSpan * 1.5));   // murky green shallows -> dark teal deeps (not uniform blue)
        float body = 1. - exp(-dm / (uSpan * .1));                                                           // Beer-Lambert-ish opacity: clear in the shallows, builds with depth
        vec3 col = mix(scat, sky, fres) + uSunCol * pow(max(dot(R, uSun), 0.), 220.) * (.5 + .6 * uWind) * fres;
        col += vec3(.75, .88, 1.) * smoothstep(.55, .9, h0) * .12;                                             // ripple crests, soft
        float edge = smoothstep(.0, .012, dn) * (1. - smoothstep(.012, .05, dn));                              // foam only on the shore line, broken up, and only when windy
        float foam = edge * smoothstep(.62, .85, vn(p / uSpan * 38. + uTime * .25) * vn(p / uSpan * 17. - uTime * .1)) * (.15 + uWind) * .8;
        col = mix(col, vec3(.86, .9, .88), clamp(foam, 0., .4));
        col = mix(col, uHorizon, smoothstep(uFog.x, uFog.y, distance(uCam, vW)));
        float alpha = mix(body * .92, 1., fres * .9) * smoothstep(.0, .05, dn) + foam * .15;
        gl_FragColor = vec4(col, clamp(alpha, 0., 1.)); }`}));
  water.position.set(pond.cx, pond.wl, pond.cz); water.renderOrder = 2; water.frustumCulled = false; group.add(water);

  // ---- water plants: lily pads, lotus (leaves + flowers), cattails and shore reeds
  const aquatic = []; let api_spots = [];
  const staticKind = (geo, mat, n, fill) => {
    const rng = mulberry(hashStr(seed + ':aq:' + aquatic.length)), off = new Float32Array(n * 3), prm = new Float32Array(n * 4), msc = new Float32Array(n * 4), clr = new Float32Array(n * 3); let m = 0;
    const put = (x, y, z, p, mi, cl) => { off.set([x, y, z], m * 3); prm.set(p, m * 4); msc.set(mi, m * 4); if(cl) clr.set(cl, m * 3); m++; };
    fill({rng, put, count: () => m, n});
    const g = new THREE.InstancedBufferGeometry(); g.index = geo.index; for(const a of ['position', 'normal', 'aPart', 'aAttach']) g.setAttribute(a, geo.attributes[a]);
    g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off.subarray(0, m * 3), 3)); g.setAttribute('aParam', new THREE.InstancedBufferAttribute(prm.subarray(0, m * 4), 4));
    g.setAttribute('aMisc', new THREE.InstancedBufferAttribute(msc.subarray(0, m * 4), 4)); g.setAttribute('aColor', new THREE.InstancedBufferAttribute(clr.subarray(0, m * 3), 3));
    g.instanceCount = m; const mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false; mesh.receiveShadow = true; group.add(mesh); aquatic.push({mesh, full: m}); };
  { // geometry
    const padPos = [0, 0, 0], padIdx = [], SEGS = 20; for(let i = 0; i <= SEGS; i++){ const a = .32 + i / SEGS * (Math.PI * 2 - .32); padPos.push(Math.cos(a), 0, Math.sin(a)); } for(let i = 1; i <= SEGS; i++) padIdx.push(0, i, i + 1);
    const padGeo = geo([{pos: padPos, idx: padIdx, part: 3}]);
    const ring = (R, y, k) => ({R, y, k});
    const cupPos = [], cupIdx = [], RS = [0, .35, .7, 1], NS = 18;                                     // lotus leaf: shallow bowl with a wavy rim
    RS.forEach((r, ri) => { for(let i = 0; i < NS; i++){ const a = i / NS * Math.PI * 2, rr = r * (ri === 3 ? 1 + .07 * Math.sin(a * 7) : 1); cupPos.push(Math.cos(a) * rr, rr * rr * .22, Math.sin(a) * rr); } });
    for(let ri = 0; ri < 3; ri++) for(let i = 0; i < NS; i++){ const a = ri * NS + i, b = ri * NS + (i + 1) % NS, c = (ri + 1) * NS + i, d = (ri + 1) * NS + (i + 1) % NS; cupIdx.push(a, c, b, b, c, d); }
    const lotusLeaf = geo([{...ribbon(4, .1, 1), part: 0}, {pos: cupPos, idx: cupIdx, part: 3, attach: Array(cupPos.length / 3).fill(1)}]);
    const fpos = [], fidx = []; [[9, 1, .3, .42], [7, .9, .85, .3], [5, .75, 1.2, .26]].forEach(([n, L, elev, w]) => { for(let i = 0; i < n; i++){ const th = i / n * Math.PI * 2 + elev, ce = Math.cos(elev), se = Math.sin(elev);
      const tip = [Math.cos(th) * L * ce, L * se * .8 + .1, Math.sin(th) * L * ce], mid = tip.map(v => v * .55), side = [-Math.sin(th) * w * L, 0, Math.cos(th) * w * L], b = fpos.length / 3;
      fpos.push(0, 0, 0, mid[0] + side[0], mid[1], mid[2] + side[2], ...tip, mid[0] - side[0], mid[1], mid[2] - side[2]); fidx.push(b, b + 1, b + 2, b, b + 2, b + 3); } });
    const cpos = [], cidx = []; for(let i = 0; i < 7; i++){ const a = i / 7 * Math.PI * 2; cpos.push(Math.cos(a) * .22, .3, Math.sin(a) * .22); cidx.push(i, (i + 1) % 7, 7); } cpos.push(0, .36, 0);
    const lotusFlower = geo([{...ribbon(4, .1, 1), part: 0}, {pos: fpos, idx: fidx, part: 1, attach: Array(fpos.length / 3).fill(1)}, {pos: cpos, idx: cidx, part: 2, attach: Array(cpos.length / 3).fill(1)}]);
    const hp = [], hi = []; for(let i = 0; i < 6; i++){ const a = i / 6 * Math.PI * 2; hp.push(Math.cos(a) * .2, 0, Math.sin(a) * .2, Math.cos(a) * .2, 1, Math.sin(a) * .2); } for(let i = 0; i < 6; i++){ const a = i * 2, b = (i + 1) % 6 * 2; hi.push(a, a + 1, b, a + 1, b + 1, b); }
    const cattail = geo([{...ribbon(4, .1, 1), part: 0}, {pos: hp, idx: hi, part: 2, attach: Array(hp.length / 3).fill(1)}]);
    // reed: a round-ish culm (two crossed ribbons), three narrow arching leaves, and a feathery plume on some
    const rs = ribbon(5, .12, 1), rs2 = {pos: rs.pos.map((v, i) => i % 3 === 0 ? 0 : i % 3 === 2 ? rs.pos[i - 2] : v), idx: rs.idx};
    const reedParts = [{...rs, part: 0}, {...rs2, part: 0}];
    [[.16, .6], [.34, 2.7], [.52, 4.9]].forEach(([t, a]) => { const l = leafBlade(1, .1, .42, a, 0, 4); reedParts.push({...l, part: 3, attach: Array(l.pos.length / 3).fill(t)}); });
    { const pp = [], pi = [], m4 = new THREE.Matrix4(), v3 = new THREE.Vector3();
      for(let k = 0; k < 3; k++){ m4.makeRotationY(k * Math.PI / 3); const b = pp.length / 3;
        for(const [x, y, z] of [[-.012, 0, 0], [.012, 0, 0], [.03, .09, .005], [-.026, .09, -.005], [.02, .2, .01], [-.016, .2, -.01], [.005, .34, .03]]){ v3.set(x + y * y * .3, y, z).applyMatrix4(m4); pp.push(v3.x, v3.y, v3.z); }   // slim, feathery, tip drooping
        pi.push(b, b + 1, b + 2, b, b + 2, b + 3, b + 3, b + 2, b + 4, b + 3, b + 4, b + 5, b + 5, b + 4, b + 6); }
      reedParts.push({pos: pp, idx: pi, part: 7, attach: Array(pp.length / 3).fill(1)}); }
    const reedGeo = geo(reedParts);
    // placement: plants live in distinct ecological zones taken from the REAL terrain depth, in colonies (noise fields), never overlapping
    //   dry bank -> reeds / cattails (damp bank + a few cm of water) -> shallow water: lily pads -> deeper: lotus -> open water
    const aq = new Noise(hashStr(seed + 'aq')), taken = [], dep = (x, z) => waterDepth(x, z) / span;
    const free = (x, z, r) => taken.every(t => Math.hypot(t[0] - x, t[1] - z) > t[2] + r), claim = (x, z, r) => taken.push([x, z, r]);
    const around = (rng, k) => { const a = rng() * 6.2832, r = Math.sqrt(rng()) * pond.R * k; return [pond.cx + Math.cos(a) * r, pond.cz + Math.sin(a) * r]; };
    const PINK = [[.96, .55, .7], [.97, .95, .93], [.93, .45, .62]];
    staticKind(padGeo, vegMaterial(U, PAD_VS, 'pad'), 34, ({rng, put, count, n}) => { for(let i = 1; i < n * 40 && count() < n; i++){ const [x, z] = around(rng, 1.15), d = dep(x, z), size = span * (.02 + .05 * rng() * rng());
      if(d < .03 || d > .1 || aq.fbm(x / span * 2.2, z / span * 2.2) < .53 || !free(x, z, size * 1.1)) continue; claim(x, z, size * 1.1);
      put(x, pond.wl, z, [1, size, rng(), rng() * 6.2832], [0, rng(), 0, 0], [.8 + .35 * rng(), 0, 0]); } });
    staticKind(lotusLeaf, plantMat, 7, ({rng, put, count, n}) => { for(let i = 1; i < n * 60 && count() < n; i++){ const [x, z] = around(rng, .95), d = dep(x, z), size = span * (.045 + .035 * Math.pow(rng(), 1.5)), y = height(x, z);
      if(d < .055 || d > .13 || aq.fbm(x / span * 2.2 + 7, z / span * 2.2) < .5 || !free(x, z, size * .85)) continue; claim(x, z, size * .85);
      put(x, y, z, [(pond.wl - y) + span * (.025 + .045 * rng()), size, rng(), rng() * 6.2832], [9, rng(), .27, 0]); } });         // leaves stand a few cm above the water
    staticKind(lotusFlower, plantMat, 3, ({rng, put, count, n}) => { for(let i = 1; i < n * 80 && count() < n; i++){ const [x, z] = around(rng, .9), d = dep(x, z), size = span * (.04 + .022 * rng()), y = height(x, z);
      if(d < .06 || d > .13 || aq.fbm(x / span * 2.2 + 7, z / span * 2.2) < .5 || !free(x, z, size * 1.1)) continue; claim(x, z, size * 1.1);
      const k = rng(), open = k < .4 ? 1 : k < .7 ? .55 : .2;                                              // fully open / half open / bud
      put(x, y, z, [(pond.wl - y) + span * (.07 + .07 * rng()), size * (.7 + .3 * open), rng(), rng() * 6.2832], [0, rng(), .18, open], PINK[(rng() * 3) | 0]); } });   // flowers sit just above the leaves, barely moving
    const spots = [];                                                                                      // where dragonflies / fireflies like to be
    staticKind(cattail, plantMat, 14, ({rng, put, count, n}) => { for(let i = 1; i < n * 200 && count() < n; i++){ const [x, z] = around(rng, 1.5), ab = -dep(x, z);
      if(ab < -.012 || ab > .045 || aq.fbm(x / span * 3. + 21, z / span * 3.) < .6 || !free(x, z, span * .03)) continue; claim(x, z, span * .03);
      put(x, height(x, z), z, [span * (.12 + .15 * rng()), span * .034, rng(), rng() * 6.2832], [5, rng(), .5, .7 + .4 * rng()], [.9 + .6 * rng(), .35 + .25 * rng(), 0]); spots.push([x, pond.wl, z]); } });
    staticKind(reedGeo, plantMat, 70, ({rng, put, count, n}) => {                                          // reed clumps on the bank / very shallow edge, each stem its own height, lean and plume
      for(let c = 0; c < 400 && count() < n; c++){ const [cx, cz] = around(rng, 1.5), ab = -dep(cx, cz); if(ab < -.025 || ab > .05 || aq.fbm(cx / span * 3. + 40, cz / span * 3.) < .58 || !free(cx, cz, span * .05)) continue; claim(cx, cz, span * .05); spots.push([cx, pond.wl, cz]);
        const stems = 4 + ((rng() * 6) | 0); for(let j = 0; j < stems && count() < n; j++){ const a = rng() * 6.2832, r = span * .022 * Math.sqrt(rng()), x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r, hh = span * (.12 + .14 * rng() * (.6 + .4 * rng()));
          put(x, height(x, z), z, [hh, hh * (.3 + .12 * rng()), rng(), rng() * 6.2832], [6, clamp(.2 + rng() * .6, 0, 1), .55, rng()]); } } });
    api_spots = spots;
    // stones along the waterline (instanced, flat-shaded, partly sunk)
    { const SN2 = 130, ico = new THREE.IcosahedronGeometry(1, 0), im = new THREE.InstancedMesh(ico, new THREE.MeshStandardMaterial({roughness: 1, flatShading: true}), SN2), r = mulberry(hashStr(seed + 'stones')), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), col2 = new THREE.Color(); let k = 0;
      for(let t = 0; t < SN2 * 40 && k < SN2; t++){ const [x, z] = around(r, 1.45), ab = -dep(x, z); if(ab < -.02 || ab > .045) continue; const sz = span * (.004 + .014 * r() * r());
        e.set(r() * 3, r() * 6, r() * 3); q.setFromEuler(e); m4.compose(new THREE.Vector3(x, height(x, z) + sz * .15, z), q, new THREE.Vector3(sz * (1 + .5 * r()), sz * (.5 + .4 * r()), sz * (1 + .4 * r())));
        im.setMatrixAt(k, m4); im.setColorAt(k, col2.setRGB(.2 + .14 * r(), .19 + .12 * r(), .16 + .1 * r(), THREE.SRGBColorSpace)); k++; }
      im.count = k; im.receiveShadow = true; im.castShadow = false; group.add(im); }
  }

  // ---- rain impact droplets: tiny translucent beads thrown up from each impact (ground and water), ballistic arcs
  const DR = 3000, dg = new THREE.InstancedBufferGeometry(); dg.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3)); dg.setIndex([0, 1, 2, 1, 3, 2]);
  { const pos = new Float32Array(DR * 3), sd = new Float32Array(DR * 3), r = mulberry(hashStr(seed + 'drops'));
    for(let k = 0; k < DR / 5; k++){ let x, z, y; for(let tries = 0; tries < 30; tries++){ const onWater = r() < .45, a = r() * 6.2832;
        if(onWater){ const rr = Math.sqrt(r()) * pond.R * .9; x = pond.cx + Math.cos(a) * rr; z = pond.cz + Math.sin(a) * rr; if(pondD(x, z) < .9){ y = pond.wl; break; } }
        else { const d = Math.sqrt(r()) * span * 3.2; x = center.x + Math.cos(a) * d; z = center.z + Math.sin(a) * d; if(pondD(x, z) > 1.1){ y = height(x, z); break; } } }
      const ph = r(); for(let j = 0; j < 5; j++){ const i = k * 5 + j; pos.set([x, y ?? y0, z], i * 3); sd.set([j / 5 * 6.2832 + r(), .4 + r() * .8, ph], i * 3); } }
    dg.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos, 3)); dg.setAttribute('aSd', new THREE.InstancedBufferAttribute(sd, 3)); dg.instanceCount = DR; }
  const drops = new THREE.Mesh(dg, new THREE.ShaderMaterial({uniforms: {uTime: U.uTime, uSpan: U.uSpan, uRain: U.uRain}, transparent: true, depthWrite: false,
    vertexShader: `attribute vec3 aPos; attribute vec3 aSd; uniform float uTime, uSpan, uRain; varying vec2 vUv; varying float vA;
      void main(){ float rate = .6 + fract(aPos.x * 13.7 + aPos.z * 3.1) * .5, t = fract(uTime * rate + aSd.z * 7.), tt = t / .45; vUv = position.xy;
        if(tt > 1.){ gl_Position = vec4(2., 2., 2., 1.); vA = 0.; return; }
        float r = tt * uSpan * (.022 + .03 * aSd.y), h = tt * (1. - tt) * 4. * uSpan * (.045 + .05 * aSd.y);
        vec3 w = aPos + vec3(cos(aSd.x) * r, h + uSpan * .012, sin(aSd.x) * r);
        vec4 mv = viewMatrix * vec4(w, 1.); mv.xy += position.xy * uSpan * .0042 * (1. - tt * .35); vA = uRain * (1. - tt * .6); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying vec2 vUv; varying float vA; void main(){ float r = length(vUv); if(r > 1. || vA < .02) discard;
      vec3 col = r < .45 ? vec3(.82, .93, 1.) : vec3(.4, .66, .95);                                                  // pale highlight bead with a translucent blue rim
      gl_FragColor = vec4(col, vA * (r < .45 ? .85 : .55)); }`}));
  drops.frustumCulled = false; drops.visible = false; group.add(drops);

  const lerp3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t), fogCol = new THREE.Color();

  const api = {group, wind, sunDir, sunColor: sunCol, skyColor: new THREE.Color(), groundColor: new THREE.Color(.33, .25, .15), ground: height, params: P,
    setParams(p){
      Object.assign(P, p); const w = P.weather / 100; wind.strength = P.wind / 100 * 1.5 * (1 + w * .9); U.uSeason.value = P.season / 100 * 3; U.uWet.value = smooth(.3, .7, w); U.uRain.value = smooth(.45, .85, w); rain.visible = splash.visible = drops.visible = U.uRain.value > .02; wind.speed = .4 + P.speed / 50; wind.gust = P.gust / 100; wind.setAngle(P.dir); U.uCover.value = P.clouds / 100 * .75 * (1 - w) + w * .95;
      U.uHeight.value = .35 + P.height / 50 * .65; U.uDry.value = P.dry / 100;
      const e = P.sun * Math.PI / 180, az = -.6, k = smooth(3, 40, P.sun);                  // sun elevation tints light, sky, clouds and fog
      sunDir.set(Math.cos(e) * Math.cos(az), Math.sin(e), Math.cos(e) * Math.sin(az)).normalize();
      const grey = (c, g) => c.map(v => v + (.58 + (c[0] + c[1] + c[2]) / 3 * .3 - v) * g), sc = lerp3([1, .6, .34], [1, .96, .88], k).map(v => v * (1 - .55 * w)), hz = grey(lerp3([.95, .66, .5], [.76, .86, .95], k), w * .75), zn = grey(lerp3([.22, .24, .42], [.2, .43, .82], k), w * .8);
      sunCol.setRGB(sc[0], sc[1], sc[2]); U.uSunCol.value.set(...sc); skyU.uHorizon.value.set(...hz); skyU.uZenith.value.set(...zn); skyU.uCloudCol.value.set(...lerp3([1, .86, .78], [.98, .98, 1], k));
      fogCol.setRGB(hz[0], hz[1], hz[2], THREE.SRGBColorSpace); api.skyColor.setRGB(zn[0], zn[1], zn[2], THREE.SRGBColorSpace);
      scene.fog = new THREE.Fog(fogCol, span * 1.6 * (1 - .6 * w), span * 7 * (1 - .55 * w)); waterU.uFog.value.set(span * 1.6 * (1 - .6 * w), span * 7 * (1 - .55 * w));
      U.uSunWeather = w;
    },
    update(t, camera){
      // adaptive quality: if frames get slow, thin the grass/flowers (down to 35%); recover when there is headroom
      const dt = Math.max(0, t - (api._t ?? t)); api._t = t; if(dt < .12) api._ema = (api._ema ?? .016) * .95 + dt * .05;      // ignore stalls (hidden tab, GC): they say nothing about GPU cost
      if(api._ema > .026) api.perf = Math.max(.35, (api.perf ?? 1) - dt * .08); else if(api._ema < .0185) api.perf = Math.min(1, (api.perf ?? 1) + dt * .03);
      wind.time = t; U.uTime.value = t; U.uCamPos.value.copy(camera.position); U.uWind.value = wind.strength; U.uGust.value = wind.gust; U.uSpeed.value = wind.speed; skyU.uCam.value.copy(camera.position);
      dome.position.copy(camera.position); dome.scale.setScalar(camera.far * .45);
      const dens = P.density / 100 * (api.perf ?? 1), sn = U.uSeason.value, aut = smooth(1.2, 2, sn) * (1 - smooth(2.6, 3, sn)), win = smooth(2.4, 3, sn), share = {grass: dens * (1 - .25 * win), flowers: P.flowers / 100 * (1 - win) * (1 - .5 * aut), weeds: P.weeds / 100, leaves: P.leaves / 100 * (1 + aut * 2.5), docks: P.weeds / 100, fall: P.fall / 100 * (1 + aut * 2.5) * (1 - win * .8)};
      for(const a of aquatic){ a.mesh.geometry.instanceCount = Math.floor(a.full * clamp(P.pond / 100, 0, 1)); }
      for(const m of chunks){
        if(m.userData.kind === 'fall'){ m.geometry.instanceCount = Math.floor(m.userData.full * clamp(share.fall, 0, 1)); continue; }
        const d = camera.position.distanceTo(m.userData.c), lod = m.userData.kind === 'grass' ? Math.pow(clamp(1.12 - d / (span * 4.6), .08, 1), 1.4) : clamp(1.2 - d / (span * 2.6), 0, 1);
        m.geometry.instanceCount = Math.floor(m.userData.full * lod * clamp(share[m.userData.kind], 0, 1)); m.visible = m.geometry.instanceCount > 0;
      }
    },
    pond, pondD, waterDepth, inPond: (x, z) => waterDepth(x, z) > 0, get spots(){ return api_spots; },
    setBodies(list){ list.slice(0, 5).forEach((b, i) => U.uBodies.value[i + 1].set(b.x, b.z, b.r, b.k ?? .7)); for(let i = list.length; i < 5; i++) U.uBodies.value[i + 1].set(0, 0, 1, 0); },
    stats(){ const o = {}; for(const m of chunks){ const k = m.userData.kind; o[k] = o[k] || {buffered: 0, drawn: 0}; o[k].buffered += m.userData.full; o[k].drawn += m.visible ? m.geometry.instanceCount : 0; } return o; },
    dispose(){ scene.fog = null; scene.remove(group); group.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); }); },
  };
  api.setParams({}); scene.add(group);
  return api;
}
