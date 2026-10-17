// Living-world phases 3 + 4: wildlife. Animals come from majidmanzarpour/threejs-procedural-animals (MIT, vendored in
// vendor/procedural-animals): procedurally sculpted, rigged, furred/feathered, IK-animated. This file adds the *behaviour*:
// small per-animal state machines with individual traits, so nothing moves in sync and most of the time animals do little.
//   rabbit : forage / groom / periscope, alert when the person is near, flee in bounds, then settle
//   cat    : wander, loaf, groom, sleep; sometimes stalks over to the person and sits
//   dog    : trots over to keep company, greets, sits, lies, wanders
//   crow   : hops and pecks on the ground, perches on posts/stumps/rocks, scared into flight, flock-reacts to a neighbour's takeoff
// Animals live in a metre-scaled group (model height = 1.65 m); they part the meadow grass and cast real shadows.
import * as THREE from 'three';

const mulberry = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const hashStr = s => { let h = 2166136261; for(const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const V = THREE.Vector3, TAU = Math.PI * 2;

// who appears at which wildlife level (0..100). Rare on purpose: a rabbit first, then a crow, a cat, a second crow, a dog.
const ROSTER = [['rabbit', 10], ['crow', 25], ['cat', 45], ['crow', 60], ['dog', 80]];
const FIELD_R = 3.7;                                                // metres: the meadow patch the animals stay in (the grass reaches ~4.3 m)

// Procedural moss + weathering: moss grows on up-facing surfaces and low down (more on rocks), with grain/speckle noise.
function mossy(mat, key){
  mat.customProgramCacheKey = () => 'moss-' + key;
  mat.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vMN; varying vec3 vMP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvMN = normalize(mat3(modelMatrix) * normal); vMP = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vMN; varying vec3 vMP;
      float mh(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float mn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
        return mix(mix(mix(mh(i), mh(i+vec3(1,0,0)), f.x), mix(mh(i+vec3(0,1,0)), mh(i+vec3(1,1,0)), f.x), f.y), mix(mix(mh(i+vec3(0,0,1)), mh(i+vec3(1,0,1)), f.x), mix(mh(i+vec3(0,1,1)), mh(i+vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
      { float n = mn(vMP * 9.) * .6 + mn(vMP * 31.) * .4, low = ${key === 'rock' ? '.55' : '.25'};
        float up = smoothstep(.25, .8, vMN.y + (n - .5) * .7), base = smoothstep(low, -.3, vMP.y * ${key === 'rock' ? '1.4' : '.9'} + (n - .5) * .5);
        float moss = clamp(up * ${key === 'rock' ? '1.0' : '.75'} + base * .6, 0., 1.) * smoothstep(.25, .6, n + .2);
        vec3 mc = pow(mix(vec3(.08, .19, .05), vec3(.25, .42, .1), mn(vMP * 60.)), vec3(2.2));
        diffuseColor.rgb *= .75 + .5 * n; diffuseColor.rgb = mix(diffuseColor.rgb, mc, moss * .9); }`);
  };
  return mat;
}

// Low-poly but natural rocks: a displaced icosphere with smooth normals, vertex colours (dark crevices, lighter tops, brown soil-stained base),
// a squashed random silhouette and its own roughness, so no two look alike and they sit in the terrain instead of glowing pale.
function rockMesh(rnd, R){
  const g = new THREE.IcosahedronGeometry(R, 2), p = g.attributes.position, off = rnd() * 50, col = new Float32Array(p.count * 3);
  const h = (x, y, z) => { const t = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return t - Math.floor(t); };
  const vn = (x, y, z) => { const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz, sm = t => t * t * (3 - 2 * t), u = sm(fx), v = sm(fy), w = sm(fz), L = (a, b, t) => a + (b - a) * t;
    return L(L(L(h(ix, iy, iz), h(ix + 1, iy, iz), u), L(h(ix, iy + 1, iz), h(ix + 1, iy + 1, iz), u), v), L(L(h(ix, iy, iz + 1), h(ix + 1, iy, iz + 1), u), L(h(ix, iy + 1, iz + 1), h(ix + 1, iy + 1, iz + 1), u), v), w); };
  const sx = 1 + rnd() * .45, sy = .5 + rnd() * .3, sz = 1 + rnd() * .35, tone = .8 + rnd() * .4, c = new THREE.Color();
  for(let k = 0; k < p.count; k++){
    let x = p.getX(k) / R, y = p.getY(k) / R, z = p.getZ(k) / R;
    const d = 1 + .24 * (vn(x * 2.6 + off, y * 2.6, z * 2.6) - .5) + .1 * (vn(x * 7 + off, y * 7, z * 7) - .5) - .12 * Math.max(0, -y - .35);      // lumpy, flatter underneath
    x *= d; y *= d; z *= d; const grain = vn(x * 9 + off, y * 9, z * 9);
    let l = (.2 + .1 * grain) * tone * (d < 1 ? .72 + .28 * d : 1) * (y > .45 ? 1.18 : 1);                                                       // crevices darker, tops lighter
    const soil = Math.max(0, .15 - y) * 2.2; c.setRGB(l * (1 + soil * .5), l * (1 - soil * .08) * (.96 + .06 * grain), l * (1 - soil * .35) * .94, THREE.SRGBColorSpace);
    col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b; p.setXYZ(k, x * R * sx, y * R * sy, z * R * sz);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.computeVertexNormals();
  return new THREE.Mesh(g, mossy(new THREE.MeshStandardMaterial({vertexColors: true, roughness: .72 + rnd() * .26, metalness: 0}), 'rock'));
}

export class Fauna {
  constructor({scene, meadow, span, center, seed = '1', level = 45}){
    Object.assign(this, {scene, meadow, span, center, level, recs: [], rnd: mulberry(hashStr(seed + ':fauna')), M: span / 1.65, dead: false, building: false});
    this.group = new THREE.Group(); this.group.name = 'fauna';
    this.group.position.copy(center); this.group.scale.setScalar(this.M); scene.add(this.group);
    this.person = new V(0, 1.0, 0);
    this.ground = (x, z) => (meadow.ground(center.x + x * this.M, center.z + z * this.M) - center.y) / this.M;
    this.perches = []; this.shoreSpots = []; this.#props();
  }
  r(a, b){ return a + (b - a) * this.rnd(); }
  pick(items){ let t = items.reduce((s, i) => s + i[1], 0) * this.rnd(); for(const [v, w] of items){ if((t -= w) <= 0) return v; } return items[0][0]; }
  inWater(x, z){ return this.meadow.waterDepth(this.center.x + x * this.M, this.center.z + z * this.M) > this.span * .006; }     // real terrain depth: wading deeper than ~1 cm is water
  ringPoint(a, b){ let x = 0, z = 0; for(let k = 0; k < 14; k++){ const ang = this.rnd() * TAU, r = this.r(a, b); x = Math.sin(ang) * r; z = Math.cos(ang) * r; if(!this.inWater(x, z)) break; } return [x, z]; }
  // bank point along the ray from the pond centre towards (ax, az): walk outward until the terrain climbs out of the water, then step a little further
  bank(ax, az, extra = .03){
    const m = this.meadow, M = this.M, c = this.center, px = (m.pond.cx - c.x) / M, pz = (m.pond.cz - c.z) / M;
    let dx = ax - px, dz = az - pz; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    let d = 0, step = m.pond.R / M * .02, k = 0; while(k++ < 200 && m.waterDepth(c.x + (px + dx * d) * M, c.z + (pz + dz * d) * M) > 0) d += step;
    d += this.span / M * extra; return [px + dx * d, pz + dz * d];
  }
  shore(a){ return this.bank(a.position.x, a.position.z); }
  #drink(rec){ const [x, z] = this.shore(rec.a); rec.thirst = this.r(45, 100);
    this.#walk(rec, x, z, this.#gear(rec.a, 'walk', 'shuffle', 'hop'), () => this.#act(rec, 'drink', {duration: this.r(4, 8)}, () => { const [bx, bz] = this.ringPoint(2.4, 3.3); this.#walk(rec, bx, bz, this.#gear(rec.a, 'walk', 'shuffle', 'hop')); })); }   // go, drink, pause, leave

  // ---- perch props: weathered fence posts, a stump and rocks (also give birds somewhere to land)
  #props(){
    const wood = mossy(new THREE.MeshStandardMaterial({color: 0x4f4132, roughness: .95}), 'wood');
    const add = (mesh, x, z, top, lift = 0) => { const y = this.ground(x, z); mesh.position.set(x, y + lift, z); mesh.castShadow = mesh.receiveShadow = true; this.group.add(mesh); this.perches.push(new V(x, y + top, z)); };
    const a0 = this.rnd() * TAU;
    for(let i = 0; i < 3; i++){ const a = a0 + i * .35, r = 3.1 + this.rnd() * .5, g = new THREE.BoxGeometry(.12, 1.1, .12); const m = new THREE.Mesh(g, wood); m.rotation.set((this.rnd() - .5) * .1, this.rnd() * 3, (this.rnd() - .5) * .1); add(m, Math.sin(a) * r, Math.cos(a) * r, 1.12, .55); }
    { const a = a0 + 2.6, r = 2.5, m = new THREE.Mesh(new THREE.CylinderGeometry(.22, .3, .5, 12), wood); add(m, Math.sin(a) * r, Math.cos(a) * r, .52, .25); }
    for(let i = 0; i < 2; i++){ const a = a0 + 3.6 + i * 1.3, r = 2.6 + this.rnd() * .8; add(rockMesh(() => this.rnd(), .34 + this.rnd() * .14), Math.sin(a) * r, Math.cos(a) * r, .3, .12); }
    // two perches on the pond bank (a rock half in the water, a leaning post) so birds can sit by the shore and fly across it
    { const pd = new V((this.meadow.pond.cx - this.center.x) / this.M, 0, (this.meadow.pond.cz - this.center.z) / this.M); const toward = Math.atan2(-pd.x, -pd.z);
      [[toward + .75, 'rock'], [toward - .9, 'post']].forEach(([ang, kind]) => { const [bx, bz] = this.bank(pd.x + Math.sin(ang) * 3, pd.z + Math.cos(ang) * 3, kind === 'rock' ? -.004 : .02); this.shoreSpots.push([bx, bz]);
        if(kind === 'rock'){ add(rockMesh(() => this.rnd(), .36), bx, bz, .27, .1); }
        else { const m = new THREE.Mesh(new THREE.BoxGeometry(.11, 1.0, .11), wood); m.rotation.set((this.rnd() - .5) * .25, this.rnd() * 3, (this.rnd() - .5) * .25); add(m, bx, bz, 1.02, .48); } }); }
  }

  // ---- population follows the wildlife level
  async setLevel(level){
    this.level = level;
    const want = ROSTER.filter(([, min]) => level >= min).length;
    while(this.recs.length > want){ const r = this.recs.pop(); r.a.dispose(); }
    if(this.building) return; this.building = true;
    try{
      const lib = this.lib ??= await import('../vendor/procedural-animals/src/index.js');
      while(!this.dead && this.recs.length < ROSTER.filter(([, min]) => this.level >= min).length){
        const idx = this.recs.length, [kind] = ROSTER[idx], seed = 3 + idx * 7 + (hashStr(String(this.rnd())) % 50);
        const [x, z] = this.ringPoint(2.7, 3.4), heading = this.rnd() * TAU;
        const a = await lib.createAnimal(kind, {seed, quality: 'medium', worker: false, ground: this.ground, water: (x, z) => this.inWater(x, z) ? (this.meadow.pond.wl - this.center.y) / this.M : null, perches: this.perches, position: new V(x, this.ground(x, z), z), heading});
        if(this.dead){ a.dispose(); return; }
        this.group.add(a.object); this.#mind(kind, a); await new Promise(r => setTimeout(r, 80));   // yield so frames keep rendering between builds
      }
    } finally { this.building = false; }
  }

  // ---- behaviour: one small state machine per animal, with its own temperament
  #mind(kind, a){
    const rec = {kind, a, state: 'idle', t: this.r(.5, 3), after: null, tr: {
      alert: this.r(1.9, 2.6), flee: this.r(1.0, 1.5), calm: this.r(.7, 1.4), curious: this.rnd(), lazy: this.rnd(), range: this.r(1.5, 3.3), bold: this.r(.8, 1.4), habit: 1}, thirst: this.r(14, 34)};
    a.on('arrive', () => { if(rec.state === 'walk'){ rec.state = 'idle'; rec.t = this.r(.6, 3.5) * (.6 + rec.tr.lazy); const f = rec.after; rec.after = null; f?.(); } });
    if(kind === 'crow') a.on('takeoff', () => this.#flockReact(rec));
    this.recs.push(rec);
  }
  #dist(a){ return Math.hypot(a.position.x, a.position.z); }
  #gear(a, ...names){ for(const n of names) if(a.gears[n]) return a.gears[n]; return Object.values(a.gears).sort((x, y) => x - y)[0]; }
  #act(rec, name, opts, then){                                         // postures (sit/lie/loaf/sleep) hold until told otherwise, so every action gets a timer
    const posture = ['sit', 'lie', 'loaf', 'sleep'].includes(name), dur = opts?.duration ? opts.duration + 1.5 : posture ? this.r(5, 14) : this.r(3.5, 6.5);
    rec.state = 'act'; rec.t = dur; rec.then = then; rec.actName = name;
    rec.a.play(name, opts).then(res => { if(rec.state === 'act' && rec.actName === name && !posture){ rec.state = 'idle'; rec.t = this.r(.5, 3) * (.5 + rec.tr.lazy); const f = rec.then; rec.then = null; f?.(res); } });
  }
  #walk(rec, x, z, speed, after){ const R = Math.hypot(x, z); if(R > FIELD_R){ x *= FIELD_R / R; z *= FIELD_R / R; }
    const a = rec.a.position; for(let k = 1; k <= 12; k++){ const t = k / 12, px = a.x + (x - a.x) * t, pz = a.z + (z - a.z) * t; if(this.inWater(px, pz)){ const u = Math.max(0, (k - 2) / 12); x = a.x + (x - a.x) * u; z = a.z + (z - a.z) * u; break; } }   // stop at the water's edge, never wade through
    rec.state = 'walk'; rec.after = after; rec.t = 16; rec.a.lookAt(null); rec.a.moveTo(new V(x, this.ground(x, z), z), {speed}); }
  #away(a){ return Math.atan2(a.position.x, a.position.z); }             // heading that points directly away from the person
  #flockReact(src){
    for(const o of this.recs){ if(o === src || o.kind !== 'crow' || o.state === 'fly' || o.a.state.mode !== 'ground') continue;
      if(src.a.position.distanceTo(o.a.position) < 6 && this.rnd() < .8){ o.state = 'idle'; o.t = this.r(.2, 1.3); o.flyNext = true; } }
  }

  #think(rec, dt){
    const {a, kind, tr} = rec, dp = this.#dist(a); rec.t -= dt; rec.thirst -= dt;
    if(rec.state === 'act' && rec.t <= 0){ a.stopAction(); rec.state = 'idle'; rec.t = this.r(.5, 2.5); const f = rec.then; rec.then = null; f?.('done'); return; }       // action finished (or a posture ran its time): stand up, carry on
    if(rec.state === 'walk' && rec.t <= 0){ a.stop(); rec.state = 'idle'; rec.t = this.r(.5, 2); rec.after = null; return; }                                        // never get stuck walking
    if(rec.thirst <= 0 && rec.state === 'idle' && rec.t <= 0 && (kind !== 'crow' || a.state.mode === 'ground') && !(kind === 'rabbit' && dp < tr.alert)){ this.#drink(rec); return; }   // thirst drives the trip, not a coin flip
    if(kind === 'rabbit') return this.#rabbit(rec, dp);
    if(kind === 'cat') return this.#cat(rec, dp);
    if(kind === 'dog') return this.#dog(rec, dp);
    if(kind === 'crow') return this.#crow(rec, dp);
  }
  #rabbit(rec, dp){
    const {a, tr} = rec, flee = () => { rec.state = 'flee'; rec.t = this.r(1.2, 2.4); a.lookAt(null); a.move({speed: this.#gear(a, 'bound', 'halfbound'), heading: this.#away(a) + (this.rnd() - .5) * .8}); };
    if(rec.state === 'flee'){ if(this.#dist(a) > FIELD_R) { a.move({speed: this.#gear(a, 'halfbound'), heading: Math.atan2(-a.position.x, -a.position.z)}); } if(rec.t <= 0){ a.stop(); rec.state = 'idle'; rec.t = this.r(3, 6); this.#act(rec, 'sit'); } return; }
    if(dp < tr.flee && rec.state !== 'flee'){ flee(); return; }
    const al = tr.alert * tr.habit;                                              // a rabbit gets used to a motionless person
    if(dp < al && rec.state !== 'alert' && rec.state !== 'act' || (rec.state === 'alert' && rec.t > 0 && dp < al)){
      if(rec.state !== 'alert'){ a.stop(); a.lookAt(this.person); rec.state = 'alert'; rec.t = this.r(2.5, 4.5); tr.habit = Math.max(.55, tr.habit * .88); a.play('periscope'); } return; }
    if(rec.state === 'alert'){ a.lookAt(null); if(dp < tr.flee * tr.bold) flee(); else { const [x, z] = this.ringPoint(Math.max(al + .7, 2.7), tr.range + 1.4); this.#walk(rec, x, z, this.#gear(a, 'shuffle', 'halfbound')); } return; }
    if(rec.state !== 'idle' || rec.t > 0) return;
    const go = () => { const [x, z] = this.ringPoint(Math.max(tr.alert + .3, 2.2), tr.range + 1.2); this.#walk(rec, x, z, this.#gear(a, 'shuffle', 'halfbound')); };
    switch(this.pick([['wander', 3], ['eat', 3 - tr.lazy * 1], ['groom', 1.5], ['look', 1.2], ['sit', 1.2 + tr.lazy], ['drink', .9]])){
      case 'drink': this.#drink(rec); break;
      case 'wander': go(); break;
      case 'eat': this.#act(rec, 'eat', {duration: this.r(3, 9)}); break;
      case 'groom': this.#act(rec, 'groom'); break;
      case 'look': this.#act(rec, 'periscope'); break;
      default: this.#act(rec, 'sit'); }
  }
  #cat(rec, dp){
    const {a, tr} = rec; if(rec.state !== 'idle' || rec.t > 0) return;
    const walk = this.#gear(a, 'walk');
    switch(this.pick([['wander', 2], ['groom', 2], ['loaf', 2 + tr.lazy * 2], ['sleep', tr.lazy * 2], ['blink', 1], ['drink', .7], ['stalk', dp > 1.8 ? tr.curious * 2.4 : 0], ['sit', 1]])){
      case 'drink': this.#drink(rec); break;
      case 'wander': { const [x, z] = this.ringPoint(1.9, tr.range + 1); this.#walk(rec, x, z, walk); break; }
      case 'stalk': { const f = (dp - 1.5) / dp; this.#walk(rec, a.position.x * (1 - f * .9), a.position.z * (1 - f * .9), walk, () => { a.lookAt(this.person); this.#act(rec, 'sit', {}, () => this.#act(rec, 'slowblink')); }); break; }
      case 'groom': this.#act(rec, 'groom'); break;
      case 'loaf': this.#act(rec, 'loaf'); rec.t = this.r(8, 18); break;
      case 'sleep': this.#act(rec, 'sleep', {side: this.rnd() < .5 ? 1 : -1}); rec.t = this.r(10, 22); break;
      case 'blink': this.#act(rec, 'slowblink'); break;
      default: this.#act(rec, 'sit'); }
  }
  #dog(rec, dp){
    const {a, tr} = rec; if(rec.state !== 'idle' || rec.t > 0) return;
    const trot = this.#gear(a, 'trot', 'walk');
    switch(this.pick([['come', dp > 2.6 ? 3 : 0], ['wander', 2], ['sniff', 2], ['sit', 1.5], ['lie', tr.lazy * 2], ['greet', dp < 2.8 ? 1.5 : 0], ['dig', .5], ['drink', 1.2]])){
      case 'drink': this.#drink(rec); break;
      case 'come': { const f = (dp - this.r(1.6, 2.2)) / dp; this.#walk(rec, a.position.x * (1 - f), a.position.z * (1 - f), trot, () => { a.lookAt(this.person); this.#act(rec, 'greet', {}, () => this.#act(rec, 'sit')); }); break; }
      case 'wander': { const [x, z] = this.ringPoint(1.5, tr.range + .8); this.#walk(rec, x, z, this.#gear(a, 'walk')); break; }
      case 'sniff': this.#act(rec, 'sniff'); break;
      case 'sit': a.lookAt(this.person); this.#act(rec, 'sit'); rec.t = this.r(5, 12); break;
      case 'lie': this.#act(rec, 'lie'); rec.t = this.r(8, 18); break;
      case 'greet': a.lookAt(this.person); this.#act(rec, 'greet'); break;
      default: this.#act(rec, 'dig'); }
  }
  #crow(rec, dp){
    const {a, tr} = rec, mode = a.state.mode;
    if(rec.state === 'fly'){ if(mode === 'ground' || mode === 'perch'){ rec.state = 'idle'; rec.t = this.r(4, 10) * (mode === 'perch' ? 1.6 : 1); } return; }
    if(mode === 'ground' && dp < tr.flee * 1.6 + .2 && rec.state !== 'fly'){ this.#fly(rec, true); return; }            // too close: up and away
    if(rec.state !== 'idle' || rec.t > 0) return;
    if(rec.flyNext){ rec.flyNext = false; this.#fly(rec); return; }
    if(mode === 'perch'){ const pk = this.pick([['look', 3], ['fly', 1.2], ['cross', .9]]); if(pk === 'cross'){ this.#fly(rec, false, true); return; } pk === 'look' ? (a.lookAt(new V(this.r(-4, 4), this.r(.3, 2), this.r(-4, 4))), rec.t = this.r(2, 6)) : this.#fly(rec); return; }
    switch(this.pick([['hop', 3], ['eat', 3], ['look', 2], ['fly', .7 + tr.curious], ['cross', .6]])){
      case 'cross': this.#fly(rec, false, true); break;
      case 'hop': { const [x, z] = this.ringPoint(1.8, FIELD_R - .3); this.#walk(rec, x, z, this.#gear(a, 'walk', 'hop')); break; }
      case 'eat': this.#act(rec, 'eat', {duration: this.r(3, 7)}); break;
      case 'look': a.lookAt(new V(this.r(-4, 4), this.r(.3, 1.2), this.r(-4, 4))); rec.t = this.r(1.5, 4); break;
      default: this.#fly(rec); }
  }
  #fly(rec, scared = false, cross = false){
    const {a} = rec; a.lookAt(null); rec.state = 'fly';
    const here = a.position, free = this.perches.filter(p => !this.recs.some(o => o !== rec && o.kind === 'crow' && o.a.position.distanceTo(p) < .5));
    const useP = free.length && (scared ? true : this.rnd() < .6), land = () => { const [x, z] = this.ringPoint(1.8, FIELD_R - .3); return new V(x, this.ground(x, z), z); };
    const bankPerches = this.perches.filter(p => this.shoreSpots.some(([sx, sz]) => Math.hypot(sx - p.x, sz - p.z) < .6) && !this.recs.some(o => o !== rec && o.kind === 'crow' && o.a.position.distanceTo(p) < .5));
    const dest = cross && bankPerches.length ? bankPerches.reduce((b, p) => p.distanceTo(here) > b.distanceTo(here) ? p : b, bankPerches[0]) : useP ? (scared ? free.reduce((b, p) => p.length() > b.length() ? p : b, free[0]) : free[(this.rnd() * free.length) | 0]) : land();
    const done = () => { if(rec.state === 'fly'){ rec.t = this.r(4, 10); } };
    ((useP || (cross && bankPerches.length)) ? a.play('perch', {target: dest.clone()}) : a.play('land', {target: dest})).then(done);
  }

  // ---- distance LOD: the coat's cost is geometry (~30k verts x one instance per fur shell), not pixels, so the shell count follows the
  // animal's share of the screen height (offscreen: none). Near animals keep the full coat; hysteresis stops tier flicker.
  static SHELLS = [16, 10, 7, 5, 3, 0]; static FRAC = [.6, .3, .12, .05, .022]; static SIZE = {rabbit: .4, crow: .5, cat: .5, dog: .8};   // shells per tier, screen-height fractions between tiers, body height (m)
  #lod(camera){
    camera.updateMatrixWorld();
    const fr = this.frustum ??= new THREE.Frustum(), s = this.sph ??= new THREE.Sphere(), p = this.lp ??= new V(), N = Fauna.FRAC.length;
    fr.setFromProjectionMatrix((this.pm ??= new THREE.Matrix4()).multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    for(const rec of this.recs){
      const mode = rec.a.state.mode, body = Fauna.SIZE[rec.kind] ?? .5, h = body * (mode === 'air' || mode === 'takeoff' || mode === 'landing' ? 1.8 : 1) * this.M;
      p.copy(rec.a.position); p.y += body * .5; this.group.localToWorld(p); s.set(p, h * 1.2);
      const f = h / (2 * Math.max(camera.position.distanceTo(p), 1e-3) * tanH);
      let t = fr.intersectsSphere(s) ? Fauna.FRAC.findIndex(x => f >= x) : N; if(t < 0) t = N;
      const cur = rec.tier ?? t;
      if(t > cur && f >= Fauna.FRAC[cur] * .87 && t < N) t = cur;       // smaller: drop a tier only once clearly below its edge
      else if(t < cur && f <= Fauna.FRAC[t] * 1.15) t = cur;            // bigger: gain a tier only once clearly above its edge
      if(t !== rec.tier){ rec.tier = t; rec.a.render.setQuality?.('medium', {shells: Fauna.SHELLS[t], transition: t === N || cur === N ? 0 : .5}); rec.a.setLod(t >= 4 ? 2 : 0); }
    }
  }
  update(dt, camera){
    if(this.dead) return; dt = Math.min(dt, .1);
    const bodies = [];
    for(const rec of this.recs){
      rec.a.update(dt); this.#think(rec, dt);
      const g = rec.a.state.mode === 'air' || rec.a.state.mode === 'takeoff' || rec.a.state.mode === 'landing';
      if(!g) bodies.push({x: this.center.x + rec.a.position.x * this.M, z: this.center.z + rec.a.position.z * this.M, r: (rec.kind === 'dog' ? .32 : rec.kind === 'cat' ? .24 : rec.kind === 'rabbit' ? .17 : .12) * this.M, k: .7});
    }
    this.meadow.setBodies(bodies); if(camera) this.#lod(camera);
  }
  dispose(){ this.dead = true; for(const r of this.recs) r.a.dispose(); this.recs = []; this.group.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); this.scene.remove(this.group); this.meadow.setBodies([]); }
}
