// Living-world phase 5: micro-life. Butterflies, dragonflies and fireflies, drawn as three instanced meshes (3 draw calls).
// Everything is animated on the GPU from a time uniform: each insect follows its own wandering path (sums of sines with its own
// rates) around a patch of flowers, faces along its velocity, and flaps with its own rhythm - nothing is in sync.
// Fireflies only glow when the sun is low (night factor), pulsing at individual rates.
import * as THREE from 'three';

const mulberry = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const hashStr = s => { let h = 2166136261; for(const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

const PATH = /* glsl */`
attribute vec3 aOff; attribute vec4 aParam; attribute vec3 aColor;      // centre, (radius, speed, phase, size), colour
uniform float uTime, uSpan;
vec3 pathAt(float t){
  float R = aParam.x, sp = aParam.y, ph = aParam.z;
  vec3 q;
  q.x = sin(t * sp * .9 + ph) * R + sin(t * sp * 2.3 + ph * 3.) * R * .35;
  q.z = cos(t * sp * .7 + ph * 2.) * R + sin(t * sp * 1.9 + ph) * R * .3;
  q.y = (.5 + .5 * sin(t * sp * 1.3 + ph * 5.)) * uSpan * .22 + sin(t * sp * 4.1 + ph) * uSpan * .015;     // bobbing flight
  return aOff + q;
}
mat3 basis(vec3 p0, vec3 p1){ vec3 f = normalize(p1 - p0 + vec3(0., 1e-5, 0.)); vec3 r = normalize(cross(f, vec3(0., 1., 0.)) + vec3(1e-5, 0., 0.)); return mat3(r, cross(r, f), f); }
`;
const BUTTERFLY_VS = /* glsl */`${PATH}
attribute vec2 aUv; varying vec2 vUv; varying vec3 vCol;
void main(){
  float t = uTime, size = aParam.w, flap = t * (13. + aParam.z * 7.) + aParam.z * 30.;
  vec3 p = pathAt(t), p1 = pathAt(t + .08); mat3 B = basis(p, p1);              // columns: right, up, forward
  float a = (.25 + .85 * sin(flap)) * sign(position.x);                               // wings beat up and down
  vec3 local = vec3(position.x * cos(a), abs(position.x) * sin(a) + position.z * 0., position.y);
  vec3 world = p + B * local * size;
  vUv = aUv; vCol = aColor;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.);
}`;
const BUTTERFLY_FS = /* glsl */`varying vec2 vUv; varying vec3 vCol;
void main(){ float edge = smoothstep(.72, .98, max(abs(vUv.x), abs(vUv.y * .9)));                    // dark rim, pale spots
  vec3 c = mix(vCol, vec3(.08, .06, .05), edge * .85); c = mix(c, vec3(1., .96, .85), smoothstep(.12, .0, length(vUv - vec2(.55 * sign(vUv.x), .35))) * .8);
  c *= .8 + .35 * smoothstep(0., 1., abs(vUv.x)); gl_FragColor = vec4(c, 1.); }`;
const DRAGON_VS = /* glsl */`${PATH}
attribute float aPart; varying vec3 vCol; varying float vWing;
void main(){
  float t = uTime * (1. + aParam.z * .3), size = aParam.w;
  float dart = smoothstep(.2, .9, sin(t * aParam.y * .8 + aParam.z * 9.) * .5 + .5);                // hover, then dart
  vec3 p = pathAt(t + dart * .6), p1 = pathAt(t + dart * .6 + .06); mat3 B = basis(p, p1);
  vec3 local = position;
  if(aPart > .5){ float a = sin(uTime * 70. + aParam.z * 40.) * .35 * (1. - dart * .5); local = vec3(position.x * cos(a), abs(position.x) * sin(a), position.z); }
  vec3 world = p + B * local * size; vCol = aColor; vWing = aPart;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.);
}`;
const DRAGON_FS = /* glsl */`varying vec3 vCol; varying float vWing;
void main(){ vec3 c = vWing > .5 ? vec3(.8, .9, 1.) : vCol; gl_FragColor = vec4(c, vWing > .5 ? .55 : 1.); }`;
const FLY_VS = /* glsl */`${PATH}
uniform float uNight; varying float vGlow; varying vec2 vUv;
void main(){
  float t = uTime * .5, ph = aParam.z;
  vec3 p = pathAt(t); p.y = aOff.y + (.5 + .5 * sin(t * aParam.y * 1.3 + ph * 5.)) * uSpan * .3 + uSpan * .02;
  float pulse = pow(max(0., sin(uTime * (.7 + ph * .8) + ph * 12.)), 5.);
  vGlow = pulse * uNight; vUv = position.xy * 2.;
  vec4 mv = viewMatrix * vec4(p, 1.); mv.xy += position.xy * uSpan * .06 * (.4 + vGlow);          // camera-facing glow quad
  gl_Position = projectionMatrix * mv;
}`;
const FLY_FS = /* glsl */`varying float vGlow; varying vec2 vUv;
void main(){ float r = length(vUv); float g = smoothstep(1., 0., r) * vGlow; if(g < .01) discard;
  gl_FragColor = vec4(vec3(.75, 1., .35) * g * 1.6, g); }`;

export class Insects {
  constructor({scene, meadow, span, center, seed = '1', level = 50}){
    Object.assign(this, {scene, meadow, span, center, level, dead: false});
    const rnd = mulberry(hashStr(seed + ':insects')), group = this.group = new THREE.Group(); group.name = 'insects';
    this.U = {uTime: {value: 0}, uSpan: {value: span}, uNight: {value: 0}};
    // flower patches to hover around (taken from the meadow's flower instances); fall back to rings around the model
    const spots = []; meadow.group.children.forEach(m => { if(m.userData.kind === 'flowers' && m.geometry.attributes.aOff.count > 3){ const a = m.geometry.attributes.aOff; spots.push([a.getX(0), a.getY(0), a.getZ(0)], [a.getX(3), a.getY(3), a.getZ(3)]); } });
    const spot = () => spots.length ? spots[(rnd() * spots.length) | 0] : [center.x + (rnd() - .5) * span * 3, center.y, center.z + (rnd() - .5) * span * 3];
    const water = meadow.spots?.length ? meadow.spots : null;                                    // reed / cattail clumps at the pond: dragonflies and fireflies belong there
    const wspot = () => water ? water[(rnd() * water.length) | 0] : spot();
    const inst = (n, geo, mat, fill) => { const g = new THREE.InstancedBufferGeometry(); g.index = geo.index; for(const k in geo.attributes) g.setAttribute(k, geo.attributes[k]);
      const off = new Float32Array(n * 3), prm = new Float32Array(n * 4), col = new Float32Array(n * 3);
      for(let i = 0; i < n; i++) fill(i, off, prm, col);
      g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 3)); g.setAttribute('aParam', new THREE.InstancedBufferAttribute(prm, 4)); g.setAttribute('aColor', new THREE.InstancedBufferAttribute(col, 3));
      g.instanceCount = n; const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.userData.full = n; group.add(m); return m; };

    const BCOL = [[.95, .55, .1], [.97, .97, .92], [.35, .55, .95], [.98, .85, .2], [.85, .3, .25]];
    const wing = [[0, .1, .9, .55, 1, .05], [0, .1, 1, .05, .35, -.2], [0, -.05, .55, -.15, .6, -.75], [0, -.05, .6, -.75, .1, -.5]];           // fore + hind wing triangles (x,y pairs)
    const bp = [], bu = [];
    for(const sgn of [1, -1]) for(const w of wing){ const tri = [[w[0], w[1]], [w[2], w[3]], [w[4], w[5]]]; for(const [x, y] of tri){ bp.push(x * sgn, y, 0); bu.push(x * sgn, y); } }
    const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3)); bg.setAttribute('aUv', new THREE.Float32BufferAttribute(bu, 2)); bg.setIndex([...Array(bp.length / 3).keys()]);
    this.butterflies = inst(14, bg, new THREE.ShaderMaterial({vertexShader: BUTTERFLY_VS, fragmentShader: BUTTERFLY_FS, uniforms: this.U, side: THREE.DoubleSide}), (i, off, prm, col) => {
      const s = spot(); off.set([s[0], s[1], s[2]], i * 3); prm.set([span * (.25 + rnd() * .5), .35 + rnd() * .5, rnd() * 6.28, span * (.03 + rnd() * .025)], i * 4); col.set(BCOL[(rnd() * BCOL.length) | 0], i * 3); });

    const dp = [], dpart = [], di = []; const add = (verts, part) => { const b = dp.length / 3; for(const v of verts){ dp.push(...v); dpart.push(part); } return b; };
    { const b = add([[-.04, 0, -.9], [.04, 0, -.9], [.05, 0, .5], [-.05, 0, .5], [0, 0, 1]], 0); di.push(b, b + 1, b + 2, b, b + 2, b + 3, b + 3, b + 2, b + 4);
      for(const [z, l] of [[.35, 1.1], [.2, .95]]){ const w = add([[0, 0, z], [l, 0, z + .1], [l * .9, 0, z - .15], [-l, 0, z + .1], [-l * .9, 0, z - .15]], 1); di.push(w, w + 1, w + 2, w, w + 3, w + 4); } }
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3)); dg.setAttribute('aPart', new THREE.Float32BufferAttribute(dpart, 1)); dg.setIndex(di);
    this.dragonflies = inst(3, dg, new THREE.ShaderMaterial({vertexShader: DRAGON_VS, fragmentShader: DRAGON_FS, uniforms: this.U, side: THREE.DoubleSide, transparent: true}), (i, off, prm, col) => {
      const s = wspot(); off.set([s[0], s[1] + span * .1, s[2]], i * 3); prm.set([span * (.35 + rnd() * .35), .5 + rnd() * .4, rnd() * 6.28, span * .09], i * 4); col.set([[.1, .35, .75], [.1, .6, .4], [.7, .15, .1]][i % 3], i * 3); });

    const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.Float32BufferAttribute([-.5, -.5, 0, .5, -.5, 0, -.5, .5, 0, .5, .5, 0], 3)); fg.setIndex([0, 1, 2, 1, 3, 2]);
    this.fireflies = inst(26, fg, new THREE.ShaderMaterial({vertexShader: FLY_VS, fragmentShader: FLY_FS, uniforms: this.U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending}), (i, off, prm, col) => {
      const s = rnd() < .65 ? wspot() : spot(), j = span * (rnd() - .5) * .3; off.set([s[0] + j, s[1], s[2] + j], i * 3); prm.set([span * (.2 + rnd() * .4), .3 + rnd() * .5, rnd() * 6.28, 1], i * 4); });
    scene.add(group); this.setLevel(level);
  }
  setLevel(l){ this.level = l; const f = Math.min(1, l / 100); this.butterflies.geometry.instanceCount = Math.floor(this.butterflies.userData.full * f);
    this.dragonflies.geometry.instanceCount = Math.floor(this.dragonflies.userData.full * Math.min(1, f * 1.4)); this.fireflies.geometry.instanceCount = Math.floor(this.fireflies.userData.full * f); }
  setNight(n){ this.U.uNight.value = n; const day = 1 - n; this.butterflies.visible = this.dragonflies.visible = day > .15; }
  update(t){ this.U.uTime.value = t; }
  dispose(){ this.dead = true; this.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); }); this.scene.remove(this.group); }
}
