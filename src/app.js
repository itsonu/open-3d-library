import * as THREE from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {FBXLoader} from 'three/addons/loaders/FBXLoader.js';
import {OBJLoader} from 'three/addons/loaders/OBJLoader.js';
import {MTLLoader} from 'three/addons/loaders/MTLLoader.js';

const $ = s => document.querySelector(s);
const LABEL = {character:'Characters', outfit:'Outfits & hair', pose:'Poses', reference:'2D references', motion:'Motion'};
const VIEW = ['glb','gltf','fbx','obj'], IMG = ['png','jpg','jpeg','webp','gif'], AUD = ['wav','mp3','ogg','m4a'];
const ext = n => n.split('.').pop().toLowerCase();
const url = (it, n) => `assets/${encodeURIComponent(it.id)}/${encodeURIComponent(n)}`;
const mb = b => b > 1e6 ? (b/1e6).toFixed(1)+' MB' : Math.max(1,Math.round(b/1e3))+' KB';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = t => `${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}`;
const pickModel = it => it.files.filter(f => VIEW.includes(ext(f.n))).sort((a,b) => VIEW.indexOf(ext(a.n)) - VIEW.indexOf(ext(b.n)))[0];

// Some FBX exports have broken blend-shape data that crashes three's stock loader; retry with a local copy of the loader that skips morph targets.
let fbxPatched;
const patchedFBX = () => fbxPatched ??= import('./loaders/FBXLoaderNoMorph.js').then(m => m.FBXLoader);

// ---------- model loading (shared by viewer and thumbnail generator) ----------
function fetchModel(it, file, onProg){
  return new Promise((resolve, rej) => {
    let obj = null, idle = false, fired = false;      // resolve once the model AND its textures have loaded
    const fin = () => { if(obj && idle && !fired){ fired = true; fixTextures(obj, it).then(() => resolve(obj)); } };
    const res = o => { obj = o; fin(); setTimeout(() => { idle = true; fin(); }, 20000); };   // 20 s safety net
    const norm = n => n.toLowerCase().replace(/\.[^.]+$/,'').replace(/[^a-z0-9]/g,'');   // 'Material #18_Diffuse.png' ~ 'Material__18_Diffuse.jpeg'
    const names = new Map(it.files.filter(f => IMG.includes(ext(f.n))).map(f => [norm(f.n), f.n]));
    const mgr = new THREE.LoadingManager(() => { idle = true; fin(); });
    mgr.setURLModifier(u => {
      if(/^(blob|data):/.test(u)) return u;
      const base = decodeURIComponent(u.split('?')[0]).split(/[\\/]/).pop(), k = norm(base);
      if(names.has(k)) return url(it, names.get(k));
      return u;
    });
    const e = ext(file.n), u = url(it, file.n);
    if(e==='glb'||e==='gltf') new GLTFLoader(mgr).load(u, g => { g.scene.animations = g.animations; res(g.scene); }, onProg, rej);
    else if(e==='fbx') new FBXLoader(mgr).load(u, res, onProg, err => err instanceof TypeError ? patchedFBX().then(L => new L(mgr).load(u, res, onProg, rej), rej) : rej(err));
    else {
      const want = file.n.replace(/\.obj$/i,'.mtl').toLowerCase(), mtl = it.files.find(f => f.n.toLowerCase() === want)?.n;
      const go = mats => { const l = new OBJLoader(mgr); if(mats) l.setMaterials(mats); l.load(u, res, onProg, rej); };
      if(mtl) new MTLLoader(mgr).load(url(it, mtl), m => { m.preload(); go(m); }, undefined, () => go()); else go();
    }
  });
}
// Some exports lose their texture links (FBX pointing at "tmp123.fbm/image_0_png", GLB stripped of its images, FBX whose
// materials just lack maps). Repair in order: 1) explicit per-model rules (item.textureOverrides), 2) match image files to
// material names by role (bodi -> bodi_Diffuse / bodi_Normal), 3) single-material models take the folder's colour image,
// 4) drop any map whose image never arrived (it would render black).
async function fixTextures(obj, it){
  const imgs = it.files.filter(f => IMG.includes(ext(f.n)));
  const cache = {}, jobs = [];
  const tex = (f, srgb) => (cache[f.n] ??= new THREE.TextureLoader().loadAsync(url(it, f.n))).then(t => { t = t.clone(); t.needsUpdate = true; if(srgb) t.colorSpace = THREE.SRGBColorSpace; return t; });
  const put = (m, k, f) => jobs.push(tex(f, k==='map').then(t => { m[k] = t; if(k==='map') m.vertexColors = false; m.needsUpdate = true; }, () => {}));
  const byName = n => imgs.find(f => f.n === n);
  const role = n => /bump|height/i.test(n) ? 'bumpMap' : /normal|nrm|_n\.|_n$/i.test(n) ? 'normalMap' : /colou?r|diffuse|albedo|base|_c\.|_c$/i.test(n) ? 'map' : null;
  const key = n => n.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z].*$/, '');
  const fx = it.textureOverrides;
  const meshes = []; obj.traverse(o => o.isMesh && meshes.push(o));
  const done = new Set();                                   // materials set by an explicit rule are left alone below
  if(fx) for(const o of meshes){                            // rule value: an image file name, or a "#rrggbb" colour (for parts that have no texture at all)
    const v = fx[o.name] || fx['*'], f = byName(v);
    if(/^#/.test(v || '')) [].concat(o.material).forEach(m => { m.map = null; m.color.set(v); m.side = THREE.DoubleSide; m.needsUpdate = true; done.add(m); });
    else if(f) [].concat(o.material).forEach(m => { put(m, 'map', f); done.add(m); });
  }
  {
    const mats = new Set(meshes.flatMap(o => [].concat(o.material)));
    const color = imgs.find(f => role(f.n)==='map') || (imgs.length===1 ? imgs[0] : null), normal = imgs.find(f => role(f.n)==='normalMap');
    for(const m of mats){
      if(done.has(m) || m.map?.image) continue;
      const mine = m.name ? imgs.filter(f => key(f.n) && key(f.n) === key(m.name)) : [];
      if(mine.length) for(const f of mine){ const r = role(f.n); if(r && !m[r]?.image) put(m, r, f); }
      else if(mats.size === 1){ if(color) put(m, 'map', color); if(normal && !m.normalMap?.image) put(m, 'normalMap', normal); }
    }
  }
  await Promise.all(jobs);
  for(const o of meshes) for(const m of [].concat(o.material)) for(const k of ['map','normalMap','bumpMap','roughnessMap','metalnessMap','aoMap','emissiveMap','alphaMap','specularMap'])
    if(m[k] && !m[k].image){ m[k] = null; m.needsUpdate = true; }
}
const fetchModelRetry = async (it, file, onProg) => {   // a dropped connection mid-download shouldn't kill the load
  for(let i = 0;; i++){
    try{ return await fetchModel(it, file, onProg); }
    catch(e){ if(i >= 2 || !/fetch|network|load/i.test(String(e?.message||e))) throw e; await sleep(700*(i+1)); }
  }
};
function disposeObj(o){
  o.traverse(c => { c.geometry?.dispose(); [].concat(c.material||[]).forEach(m => { Object.values(m).forEach(v => v?.isTexture && v.dispose()); m.dispose(); }); });
}

// ---------- main 3D stage ----------
const stage = $('#stage');
const renderer = new THREE.WebGLRenderer({antialias:true, preserveDrawingBuffer:true, alpha:true});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.className = 'gl'; stage.prepend(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color('#14161a');
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), .04).texture;  // lets metallic materials reflect something
const camera = new THREE.PerspectiveCamera(40, 1, .1, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.screenSpacePanning = true;
const hemi = new THREE.HemisphereLight(0xffffff, 0x555566, 1.6); scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 2.2); scene.add(key, key.target);
const clay = new THREE.MeshStandardMaterial({color:0xb8bcc6, roughness:.85});
const sel = {box:null, mesh:null};
let sun = null, ground = null, wash = null, meadow = null, minfo = null, fauna = null, insects = null;
let model = null, grid = null, bbox = null, skel = null, home = null, meshes = [], cur = null, token = 0, view = 'lib';
const flags = {wire:false, clay:false};

function resize(){
  const w = stage.clientWidth, h = stage.clientHeight; if(!w||!h) return;
  renderer.setSize(w, h, false); camera.aspect = w/h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);

function frame(box, keepAngle){
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const d = Math.max(size.x, size.y, size.z) / (2*Math.tan(THREE.MathUtils.degToRad(camera.fov)/2)) * 1.5 || 1;
  const dir = keepAngle ? camera.position.clone().sub(controls.target).normalize() : new THREE.Vector3(.5,.25,1).normalize();
  camera.position.copy(c).addScaledVector(dir, d); controls.target.copy(c);
  camera.near = d/200; camera.far = d*200; camera.updateProjectionMatrix(); controls.update();
}
function applyMode(){
  for(const m of meshes){
    const base = flags.clay ? clay : m.userData.m0;
    m.material = base; [].concat(base).forEach(mat => mat.wireframe = flags.wire);
  }
}
function clearSel(){ if(sel.box){ scene.remove(sel.box); sel.box = null; } sel.mesh = null; }
function disposeModel(){
  stopPlayback();
  if(!model) return;
  disposeObj(model); scene.remove(model, grid, bbox); if(skel){ scene.remove(skel); skel.dispose?.(); } if(insects){ insects.dispose(); insects = null; } if(fauna){ fauna.dispose(); fauna = null; } if(meadow){ meadow.dispose(); meadow = null; } minfo = null;
  if(sun){ scene.remove(sun, sun.target, ground, wash); wash.material.map.dispose(); wash.material.dispose(); ground.material.dispose(); sun = ground = wash = null; }
  model = grid = bbox = skel = null; meshes = []; clearSel();
}

// ---------- transport: animation clips + audio, one timeline ----------
const T = {playing:false, t:0, speed:1, loop:true, dur:0, mixer:null, action:null, actions:[], audio:null, drag:false};
let analyser = null, actx = null, fdata = null;
const clock = new THREE.Clock();

function stopPlayback(){
  T.playing = false; T.t = 0; T.dur = 0; T.mixer?.stopAllAction(); T.mixer = T.action = null; T.actions = [];
  if(T.audio){ T.audio.pause(); T.audio.removeAttribute('src'); T.audio.load(); T.audio = null; }
  $('#tr').hidden = true; $('#viz').hidden = true; $('#tPlay').textContent = '▶';
}
function setupTransport(it, obj){
  const clips = obj?.animations || [];
  if(clips.length){
    T.mixer = new THREE.AnimationMixer(obj);
    T.actions = clips.map(c => T.mixer.clipAction(c));
    $('#tClip').innerHTML = clips.map((c,i) => `<option value="${i}">${c.name || 'clip '+(i+1)} (${fmt(c.duration)})</option>`).join('');
    $('#tClip').hidden = clips.length < 2; selectClip(0);
  }
  const af = it.files.find(f => AUD.includes(ext(f.n)));
  if(af){
    const a = T.audio = new Audio(url(it, af.n)); a.preload = 'auto'; a.volume = +$('#vol').value; a.playbackRate = T.speed;
    a.onloadedmetadata = () => { recompute(); };
  }
  $('#volw').hidden = !af; recompute();
}
function selectClip(i){
  T.actions.forEach(a => a.stop()); T.action = T.actions[i]; T.action.play(); $('#tClip').value = i; recompute();
}
function recompute(){
  T.dur = Math.max(T.action?.getClip().duration || 0, isFinite(T.audio?.duration) ? T.audio.duration : 0);
  $('#tr').hidden = !(T.dur > 0 || T.audio);
  $('#viz').hidden = !T.audio;
  resize();
}
function setTime(t){
  T.t = Math.max(0, Math.min(t, T.dur || 0));
  if(T.audio) T.audio.currentTime = T.t;
}
function play(on){
  if(!(T.dur > 0 || T.audio)) return;
  if(on && T.t >= T.dur - .05) setTime(0);
  T.playing = on; $('#tPlay').textContent = on ? '⏸' : '▶';
  if(T.audio){
    if(on){
      if(!actx){ actx = new AudioContext(); analyser = actx.createAnalyser(); analyser.fftSize = 128; fdata = new Uint8Array(analyser.frequencyBinCount);
        actx.createMediaElementSource(T.audio).connect(analyser); analyser.connect(actx.destination); }
      actx.resume(); T.audio.playbackRate = T.speed; T.audio.play().catch(() => {});
    } else T.audio.pause();
  }
}
function tick(dt){
  if(T.playing){
    T.t = T.audio && !T.audio.paused ? T.audio.currentTime : T.t + dt*T.speed;
    if(T.dur && T.t >= T.dur - .02){ if(T.loop){ setTime(0); T.audio && T.audio.play().catch(()=>{}); } else { setTime(T.dur); play(false); } }
  }
  if(T.action){ const d = T.action.getClip().duration; T.action.time = d ? T.t % d : 0; T.mixer.update(0); model?.userData.post?.(); }
  if(!T.drag && T.dur) $('#seek').value = T.t / T.dur * 1000;
  $('#time').textContent = `${fmt(T.t)} / ${fmt(T.dur)}`;
  if(analyser && !$('#viz').hidden){
    const c = $('#viz'), g = c.getContext('2d'); g.clearRect(0,0,c.width,c.height);
    if(T.playing){ analyser.getByteFrequencyData(fdata); const w = c.width/fdata.length;
      g.fillStyle = '#6ea8ff'; fdata.forEach((v,i) => { const h = v/255*c.height; g.fillRect(i*w+1, c.height-h, w-2, h); }); }
  }
}
$('#tPlay').onclick = () => play(!T.playing);
$('#tStop').onclick = () => { setTime(0); };
$('#seek').oninput = e => { T.drag = true; setTime(e.target.value/1000*T.dur); };
$('#seek').onchange = () => T.drag = false;
$('#tSpeed').onchange = e => { T.speed = +e.target.value; if(T.audio) T.audio.playbackRate = T.speed; };
$('#tLoop').onclick = e => { T.loop = e.target.classList.toggle('on'); };
$('#tClip').onchange = e => selectClip(+e.target.value);
$('#vol').oninput = e => { if(T.audio) T.audio.volume = +e.target.value; };

renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if(view !== 'viewer') return;
  tick(dt); controls.update(); meadow?.update(performance.now() / 1000, camera); fauna?.update(dt, camera); insects?.update(performance.now() / 1000);
  key.position.copy(camera.position).add(new THREE.Vector3(1,2,1)); key.target.position.copy(controls.target);
  sel.box?.update();
  renderer.render(scene, camera);
});

// ---------- viewer ----------
function mount(obj){
  model = obj; scene.add(model); meshes = [];
  model.traverse(o => { if(o.isMesh){ o.userData.m0 = o.material; meshes.push(o); } });
  applyMode(); model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z) || 1;
  grid = new THREE.GridHelper(span*3, 30, 0x6b7280, 0x3b4150); grid.position.y = box.min.y; grid.visible = $('#bGrid').classList.contains('on');
  grid.material.transparent = true; grid.material.opacity = .5;
  bbox = new THREE.Box3Helper(box, 0x6ea8ff); bbox.visible = $('#bBox').classList.contains('on');
  scene.add(grid, bbox);
  const nBones = meshes.reduce((n, m) => n + (m.isSkinnedMesh ? m.skeleton.bones.length : 0), 0);
  if(nBones){ skel = new THREE.SkeletonHelper(model); skel.material.depthTest = false; skel.visible = $('#bSkel').classList.contains('on'); scene.add(skel); }
  $('#bSkel').hidden = !nBones;
  // grounding for the scenery backdrop: fixed sun with a soft shadow on an invisible floor, plus an ink-wash blob under the feet
  const c = box.getCenter(new THREE.Vector3());
  sun = new THREE.DirectionalLight(0xfff0d8, 2.2); sun.position.set(c.x + span*1.4, box.max.y + span*1.6, c.z + span*.9); sun.target.position.copy(c);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = span*.002;
  Object.assign(sun.shadow.camera, {left:-span*1.4, right:span*1.4, top:span*1.4, bottom:-span*1.4, near:span*.1, far:span*6}); sun.shadow.camera.updateProjectionMatrix();
  ground = new THREE.Mesh(new THREE.PlaneGeometry(span*10, span*10), new THREE.ShadowMaterial({color:0x2a2418}));
  ground.rotation.x = -Math.PI/2; ground.position.set(c.x, box.min.y + span*.001, c.z); ground.receiveShadow = true;
  const cv = document.createElement('canvas'); cv.width = cv.height = 128; const g2 = cv.getContext('2d'), gr = g2.createRadialGradient(64,64,0,64,64,64);
  gr.addColorStop(0,'rgba(34,28,20,.9)'); gr.addColorStop(.5,'rgba(34,28,20,.35)'); gr.addColorStop(1,'rgba(34,28,20,0)'); g2.fillStyle = gr; g2.fillRect(0,0,128,128);
  wash = new THREE.Mesh(new THREE.PlaneGeometry(span*1.5, span*1.5), new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(cv), transparent:true, depthWrite:false}));
  wash.rotation.x = -Math.PI/2; wash.position.set(c.x, box.min.y + span*.002, c.z);
  meshes.forEach(m => m.castShadow = true);
  minfo = {span, center: new THREE.Vector3(c.x, box.min.y, c.z)};
  scene.add(sun, sun.target, ground, wash); sceneApply(); meadowApply();
  frame(box); home = {pos:camera.position.clone(), tgt:controls.target.clone(), near:camera.near, far:camera.far};
  $('#load').hidden = true; setupTransport(cur, obj); inspector(size);
}
function loadModel(it, file){
  const my = ++token;
  disposeModel(); $('#msg').textContent = ''; $('#load').hidden = false; $('#load').textContent = 'Loading…'; $('#load').style.setProperty('--b', cur.thumb ? `url('${cur.thumb}')` : 'none');
  fetchModelRetry(it, file, e => { if(my===token && !model && e.lengthComputable) $('#load').textContent = `Loading… ${Math.round(e.loaded/e.total*100)}%`; })
    .then(o => { if(my===token) mount(o); else disposeObj(o); })
    .catch(e => { if(my===token){ $('#load').hidden = true; $('#msg').textContent = 'Could not load this file.\n'+(e?.message||e)+'\n(is serve.py still running?)'; } });
}

function open(id){
  const it = lib.find(i => i.id===id); if(!it){ location.hash = ''; return; }
  if(it.sensitive && passed !== id){ setView('lib'); askAge(id); return; }
  setView('viewer'); cur = it; token++; disposeModel();
  $('#title').textContent = `${LABEL[it.type]||it.type} / ${it.name}`;
  document.title = `${it.name} · Motion Library`;
  const models = it.files.filter(f => VIEW.includes(ext(f.n))).sort((a,b) => VIEW.indexOf(ext(a.n)) - VIEW.indexOf(ext(b.n)));
  const imgs = it.files.filter(f => IMG.includes(ext(f.n)));
  const fsel = $('#fsel'), g = $('#gallery');
  fsel.hidden = models.length < 2; fsel.innerHTML = models.map(f => `<option>${f.n}</option>`).join('');
  const vmds = it.files.filter(f => ext(f.n)==='vmd').sort((a,b) => /cnv/i.test(a.n) - /cnv/i.test(b.n));
  const mocap = !models.length && vmds.length > 0;           // a VMD with no model: play it on the built-in mannequin (vmdplayer.js)
  if(mocap){ fsel.hidden = vmds.length < 2; fsel.innerHTML = vmds.map(f => `<option>${f.n}</option>`).join(''); }
  const is3d = models.length > 0 || mocap, isGal = !is3d && it.type==='reference' && imgs.length;
  $('#center').firstElementChild.style.display = isGal ? 'none' : ''; g.style.display = isGal ? 'grid' : 'none';
  ['bReset','bIn','bOut','bRot','bWire','bClay','bGrid','bBox','bg','bShot'].forEach(b => $('#'+b).disabled = !is3d);
  $('#load').hidden = true; $('#msg').textContent = ''; $('#bSkel').hidden = true;
  if(isGal){
    g.innerHTML = imgs.map((f,i) => `<figure data-i="${i}"><img loading="lazy" src="${f.t || url(it,f.n)}" onerror="this.onerror=null;this.src='${url(it,f.n)}'"><figcaption>${f.n}</figcaption></figure>`).join('');
    g.onclick = e => { const f = e.target.closest('figure'); if(f) lightbox(imgs.map(x => url(it,x.n)), +f.dataset.i); };
    inspector();
  } else if(mocap) loadMocap(it, vmds[0]);
  else if(is3d) loadModel(it, models[0]);
  else { setupTransport(it, null); vmdInfo(it); inspector(); }
  resize();
}
async function vmdInfo(it){
  const v = it.files.find(f => ext(f.n)==='vmd');
  $('#msg').textContent = `No 3D preview for ${[...new Set(it.files.map(f=>ext(f.n)))].join(', ')}.` + (v ? '\nReading VMD motion…' : '\nOpen it in Blender / a DCC tool.');
  if(!v) return;
  const my = cur;
  try{
    const mod = await import('../vendor/mmdparser/mmdparser.module.js'); const P = mod.MMDParser || mod;
    const buf = await (await fetch(url(it, v.n))).arrayBuffer();
    const d = new P.Parser().parseVmd(buf, true);
    const bones = new Set(d.motions.map(m => m.boneName)), last = Math.max(0, ...d.motions.map(m => m.frameNum));
    if(cur !== my) return;
    $('#msg').textContent = `VMD motion  ·  ${bones.size} bone tracks  ·  ${d.motions.length.toLocaleString()} keyframes  ·  ${(last/30).toFixed(1)} s @30fps\n`
      + 'It animates an MMD-rigged model.' + (T.audio ? '\nThe .wav plays with the controls below.' : '');
  }catch(e){ $('#msg').textContent += '\n(VMD could not be parsed)'; }
}
function loadMocap(it, file){
  const my = ++token;
  disposeModel(); $('#msg').textContent = ''; $('#load').hidden = false; $('#load').textContent = 'Reading motion…'; $('#load').style.setProperty('--b', 'none');
  fetch(url(it, file.n)).then(r => r.arrayBuffer()).then(buf => import('./vmdplayer.js').then(m => m.buildMannequin(buf)))
    .then(o => { if(my===token) mount(o); else disposeObj(o); })
    .catch(e => { if(my===token){ $('#load').hidden = true; $('#msg').textContent = 'Could not read this motion.\n' + (e?.message||e); } });
}
$('#fsel').onchange = e => { const f = cur.files.find(f => f.n===e.target.value); ext(f.n)==='vmd' ? loadMocap(cur, f) : loadModel(cur, f); };

// ---------- inspector ----------
function inspector(size){
  let h = '';
  if(model){
    let tris = 0, verts = 0; const mats = new Set(), tex = new Set();
    for(const m of meshes){
      const g = m.geometry; verts += g.attributes.position.count; tris += (g.index ? g.index.count : g.attributes.position.count)/3;
      for(const mat of [].concat(m.userData.m0)){ mats.add(mat); Object.entries(mat).forEach(([k,v]) => v?.isTexture && tex.add(k+': '+(v.name || decodeURIComponent((v.image?.src||'').split('/').pop()) || 'embedded'))); }
    }
    const nBones = meshes.reduce((n, m) => n + (m.isSkinnedMesh ? m.skeleton.bones.length : 0), 0), clips = model.animations || [];
    const usedKeys = new Set([...tex].map(t => t.split(': ').slice(1).join(': ').toLowerCase().replace(/\.[^.]+$/,'').replace(/[^a-z0-9]/g,'')));
    const unused = cur.files.filter(f => IMG.includes(ext(f.n)) && !/^gltf_embedded/.test(f.n) && !usedKeys.has(f.n.toLowerCase().replace(/\.[^.]+$/,'').replace(/[^a-z0-9]/g,''))).map(f => f.n);
    const sz = size ? [size.x,size.y,size.z].map(v => +v.toPrecision(3)).join(' × ') : '';
    h += `<h3>Model</h3>
      <div class="row"><span class="k">Meshes</span><span>${meshes.length}</span></div>
      <div class="row"><span class="k">Triangles</span><span>${Math.round(tris).toLocaleString()}</span></div>
      <div class="row"><span class="k">Vertices</span><span>${verts.toLocaleString()}</span></div>
      <div class="row"><span class="k">Materials</span><span>${mats.size}</span></div>
      <div class="row"><span class="k">Textures</span><span>${tex.size}</span></div>
      <div class="row"><span class="k">Rig</span><span>${nBones ? nBones + ' bones' : 'none'}</span></div>
      <div class="row"><span class="k">Animations</span><span>${model.animations?.length || 0}</span></div>
      <div class="row"><span class="k">Size</span><span>${sz}</span></div>
      ${clips.length ? `<h3>Animations <small>(click to play)</small></h3>${clips.map((c,i) => `<div class="mesh" data-clip="${i}"><span>▶ ${c.name || 'clip '+(i+1)}</span><small style="color:var(--dim)">${fmt(c.duration)}</small></div>`).join('')}`
        : nBones ? '<div style="color:var(--dim);margin-top:8px">Rigged (use Bones to see the skeleton) but has no animation clips.</div>' : ''}
      <h3>Meshes <small>(click = select · tick = show)</small></h3><div id="meshes">${meshes.map((m,i) =>
        `<div class="mesh" data-i="${i}"><input type="checkbox" checked data-v="${i}"><span title="${m.name}">${m.name||'mesh '+i}</span></div>`).join('')}</div>
      <h3>Selected</h3><div id="selinfo" style="color:var(--dim)">nothing</div>
      <h3>Textures applied</h3><div style="color:var(--dim);word-break:break-all">${[...tex].join('<br>') || 'none'}</div>
      ${unused.length ? `<h3>Image files not used by the model</h3><div style="color:var(--dim);word-break:break-all">${unused.join('<br>')}</div>` : ''}`;
  }
  h += `<h3>Files</h3><div class="files">${cur.files.map(f => `<div><a href="${url(cur,f.n)}" download title="${f.n}">${f.n}</a><small>${mb(f.s)}</small></div>`).join('')}</div>`;
  $('#inspBody').innerHTML = h;
}
$('#inspBody').addEventListener('click', e => {
  const v = e.target.dataset?.v;
  if(v !== undefined){ meshes[v].visible = e.target.checked; return; }
  const clip = e.target.closest('[data-clip]'); if(clip){ selectClip(+clip.dataset.clip); setTime(0); play(true); return; }
  const row = e.target.closest('.mesh'); if(row) select(meshes[+row.dataset.i]);
});
function select(m){
  clearSel(); sel.mesh = m;
  document.querySelectorAll('.mesh').forEach(r => r.classList.toggle('sel', m && meshes[+r.dataset.i]===m));
  if(!m){ $('#selinfo') && ($('#selinfo').textContent = 'nothing'); return; }
  sel.box = new THREE.BoxHelper(m, 0xffd166); scene.add(sel.box);
  const g = m.geometry, mats = [].concat(m.userData.m0);
  $('#selinfo').innerHTML = `<div class="row"><span class="k">Name</span><span>${m.name||'(unnamed)'}</span></div>
    <div class="row"><span class="k">Triangles</span><span>${Math.round((g.index?g.index.count:g.attributes.position.count)/3).toLocaleString()}</span></div>
    <div class="row"><span class="k">Material</span><span>${mats.map(x=>x.name||'(unnamed)').join(', ')}</span></div>`;
}
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2(); let down = null;
const pick = e => { const r = renderer.domElement.getBoundingClientRect(); ptr.set((e.clientX-r.left)/r.width*2-1, -((e.clientY-r.top)/r.height)*2+1); ray.setFromCamera(ptr, camera); return ray.intersectObjects(meshes.filter(m=>m.visible), false)[0]; };
renderer.domElement.addEventListener('pointerdown', e => down = [e.clientX, e.clientY]);
renderer.domElement.addEventListener('pointerup', e => { if(down && Math.hypot(e.clientX-down[0], e.clientY-down[1]) < 4 && model){ select(pick(e)?.object||null); } });
renderer.domElement.addEventListener('dblclick', e => { const h = pick(e); if(h){ select(h.object); frame(new THREE.Box3().setFromObject(h.object), true); } });

// ---------- toolbar ----------
const toggle = (id, fn) => $('#'+id).onclick = () => fn($('#'+id).classList.toggle('on'));
$('#bReset').onclick = () => { if(!home) return; camera.position.copy(home.pos); controls.target.copy(home.tgt); camera.near = home.near; camera.far = home.far; camera.updateProjectionMatrix(); controls.update(); };
const zoom = f => camera.position.sub(controls.target).multiplyScalar(f).add(controls.target);
$('#bIn').onclick = () => zoom(.8); $('#bOut').onclick = () => zoom(1.25);
toggle('bRot', on => controls.autoRotate = on);
toggle('bWire', on => { flags.wire = on; applyMode(); });
toggle('bClay', on => { flags.clay = on; applyMode(); });
toggle('bGrid', on => grid && (grid.visible = on && !SC.on));
toggle('bBox', on => bbox && (bbox.visible = on));
toggle('bSkel', on => skel && (skel.visible = on));
toggle('bInsp', on => { $('#viewer').classList.toggle('noinsp', !on); resize(); });
$('#bg').onchange = () => sceneApply();
$('#bShot').onclick = () => { renderer.render(scene, camera); renderer.domElement.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = (cur?.id||'shot')+'.png'; a.click(); }); };
$('#bBack').onclick = () => location.hash = '';
const step = d => { const i = lib.indexOf(cur), n = lib[(i+d+lib.length)%lib.length]; location.hash = n.id; };
$('#bPrev').onclick = () => step(-1); $('#bNext').onclick = () => step(1);

// ---------- lightbox ----------
const lb = $('#lb'), lbImg = lb.querySelector('img'); let lbList = [], lbI = 0, S = {s:1,x:0,y:0};
const lbApply = () => lbImg.style.transform = `translate(${S.x}px,${S.y}px) scale(${S.s}) translate(-50%,-50%)`;
function lbShow(i){ lbI = (i+lbList.length)%lbList.length; lbImg.src = lbList[lbI]; S = {s:1,x:innerWidth/2,y:innerHeight/2}; lbImg.style.left = lbImg.style.top = '0'; lbApply(); }
function lightbox(list, i){ lbList = list; lb.style.display = 'block'; lbShow(i); }
lb.addEventListener('wheel', e => { e.preventDefault(); const f = e.deltaY<0 ? 1.15 : 1/1.15; S.x = e.clientX-(e.clientX-S.x)*f; S.y = e.clientY-(e.clientY-S.y)*f; S.s *= f; lbApply(); }, {passive:false});
let drag = null, moved = false;
lb.onpointerdown = e => { drag = [e.clientX-S.x, e.clientY-S.y]; moved = false; lb.setPointerCapture(e.pointerId); lb.style.cursor = 'grabbing'; };
lb.onpointermove = e => { if(drag){ moved = true; S.x = e.clientX-drag[0]; S.y = e.clientY-drag[1]; lbApply(); } };
lb.onpointerup = e => { drag = null; lb.style.cursor = 'grab'; if(!moved && e.target===lb) lb.style.display = 'none'; };
lb.ondblclick = () => lbShow(lbI);

// ---------- library (visual grid) ----------
let lib = [], filter = 'all';
let passed = null;                                          // the one item the user just confirmed; asked again next time
function askAge(id){
  $('#gate').style.display = 'flex';
  $('#gYes').onclick = () => { passed = id; $('#gate').style.display = 'none'; open(id); };
  $('#gNo').onclick = () => { $('#gate').style.display = 'none'; location.hash = ''; };
}
function setView(v){
  view = v; $('#lib').hidden = $('#hLib').hidden = v!=='lib'; $('#viewer').hidden = $('#hView').hidden = v!=='viewer';
  if(v==='lib'){ document.title = 'Motion Library'; disposeModel(); cur = null; passed = null; }
  resize();
}
function thumbOf(it){
  if(it.thumb) return it.thumb;
  const im = it.type==='reference' && it.files.find(f => IMG.includes(ext(f.n)));
  return im ? (im.t || url(it, im.n)) : null;
}
function card(it){
  const m = pickModel(it), th = thumbOf(it);
  const tag = m ? ext(m.n) : it.files.some(f => AUD.includes(ext(f.n))) ? 'audio' : it.type==='reference' ? 'images' : ext(it.files.find(f => /blend|max|vmd/.test(ext(f.n)))?.n || it.files[0]?.n || '');
  const ph = m ? '' : tag.toUpperCase();
  const ad = it.sensitive;                  // thumbnails of these stay blurred always
  return `<div class="card ${ad ? 'adult' : ''}" data-id="${it.id}">${ad ? '<span class="badge">18+</span>' : ''}<div class="th ${!th && m ? 'q' : ''}" data-th="${it.id}" ${th ? `style="--b:url('${th}')"` : ''}>${th ? `<img loading="lazy" src="${th}" onload="this.classList.add('ld')">` : `<span class="ph">${ph}</span>`}${!th && m ? '<div class="gen">making preview…</div>' : ''}</div>
    <div class="meta"><b title="${it.name}">${it.name}</b><span>${LABEL[it.type]||it.type} · ${tag}</span></div></div>`;
}
function renderLib(){
  const q = $('#q').value.trim().toLowerCase();
  $('#chips').innerHTML = ['all',...Object.keys(LABEL)].map(t => `<button class="chip ${filter===t?'on':''}" data-t="${t}">${t==='all'?'All':LABEL[t]}</button>`).join(' ');
  let out = '';
  for(const t of Object.keys(LABEL)){
    if(filter!=='all' && filter!==t) continue;
    const items = lib.filter(i => i.type===t && (i.name+' '+t).toLowerCase().includes(q));
    if(items.length) out += `<h2>${LABEL[t]} · ${items.length}</h2><div class="grid">${items.map(card).join('')}</div>`;
  }
  $('#lib').innerHTML = out || `<p style="color:var(--dim)">${lib.length ? 'Nothing matches.' : 'No assets yet — open a file or add examples'}</p>`;
}
$('#chips').onclick = e => { const t = e.target.dataset.t; if(t){ filter = t; renderLib(); } };
$('#lib').onclick = e => { const c = e.target.closest('.card'); if(c) location.hash = c.dataset.id; };
$('#q').oninput = renderLib;
$('#cw').oninput = e => document.documentElement.style.setProperty('--cw', e.target.value+'px');

// preview generator: renders each model once, posts the JPEG to serve.py so it is cached on disk
let rig = null;
function thumbRig(){
  if(rig) return rig;
  const r = new THREE.WebGLRenderer({antialias:true, preserveDrawingBuffer:true}); r.setSize(360, 480, false); r.outputColorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Scene(); s.background = new THREE.Color('#1b1e24');
  s.environment = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), .04).texture;
  s.add(new THREE.HemisphereLight(0xffffff, 0x555566, 1.6));
  const l = new THREE.DirectionalLight(0xffffff, 2.2); l.position.set(2,3,4); s.add(l);
  return rig = {r, s, cam:new THREE.PerspectiveCamera(35, .75, .1, 1000)};
}
async function makeThumb(it){
  const obj = await fetchModelRetry(it, pickModel(it), () => {}), {r, s, cam} = thumbRig();
  try{
    s.add(obj); obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const t = Math.tan(THREE.MathUtils.degToRad(cam.fov)/2);
    const d = Math.max(size.y/(2*t), size.x/(2*t*cam.aspect)) * 1.12 + size.z/2;
    cam.position.set(c.x + d*.18, c.y + size.y*.04, c.z + d); cam.near = d/100; cam.far = d*100; cam.updateProjectionMatrix(); cam.lookAt(c);
    r.render(s, cam);
    return await new Promise(res => r.domElement.toBlob(res, 'image/jpeg', .82));
  } finally { s.remove(obj); disposeObj(obj); }
}
async function thumbQueue(){
  const todo = lib.filter(i => !thumbOf(i) && pickModel(i)).sort((a,b) => pickModel(a).s - pickModel(b).s);
  let n = 0;
  for(const it of todo){
    while(view==='viewer') await sleep(1000);          // stay out of the way while a model is open
    $('#status').textContent = `making previews ${++n}/${todo.length}`;
    try{
      const blob = await makeThumb(it);
      fetch(`thumb/${it.id}.jpg`, {method:'POST', headers:{'X-O3DL':'1'}, body:blob}).catch(() => {});
      it.thumb = URL.createObjectURL(blob);
      const th = document.querySelector(`[data-th="${it.id}"]`);
      if(th){ th.style.setProperty('--b', `url('${it.thumb}')`); th.replaceChildren(Object.assign(new Image(), {src:it.thumb, onload(){ this.classList.add('ld'); }})); }
    }catch(e){ console.warn('preview failed', it.id, e); }
    await sleep(50);
  }
  $('#status').textContent = '';
}

window.mv = {THREE, renderer, scene, frame, controls, camera, get meadow(){ return meadow; }, get fauna(){ return fauna; }, get insects(){ return insects; }, get meshes(){ return meshes; }, get cur(){ return cur; }};   // console handle for debugging

// ---------- scenery backdrop: shan-shui-inf (MIT, see shanshui-LICENSE.txt) ----------
// The engine runs in a hidden iframe (it overrides Math.random). Its generated chunks are regrouped by depth into 5 layers that
// get their own parallax, blur and haze, so the scenery has real distance. The nearest layer is drawn OVER the model's feet.
const MEADOW_DEF = {height:50, density:70, wind:45, speed:50, gust:35, dir:35, dry:25, rough:35, sun:42, flowers:70, weeds:70, leaves:60, fall:60, clouds:45, wildlife:45, insects:55, weather:0, season:33, pond:70};
const SC_DEF = {meadow:{...MEADOW_DEF}, on:false, kind:'mountain', seed:'', zoom:1.3, v:0, parallax:40, mist:55, dblur:2, fore:60, shadow:45, sepia:25, hue:0, bright:100, contrast:100, sat:100, light:100};
const SC = {...SC_DEF, meadow:{...MEADOW_DEF}}; try{ Object.assign(SC, JSON.parse(localStorage.getItem('scene') || '{}')); }catch(e){}
SC.meadow = {...MEADOW_DEF, ...SC.meadow};                // fill in params added since the settings were saved
const SLIDERS = [['zoom','Zoom',.8,3,.05],['v','Vertical',-300,300,5],['parallax','Parallax',0,100,1],['mist','Distance haze',0,100,1],['dblur','Depth blur',0,8,.5],
  ['fore','Foreground ink',0,100,1],['shadow','Ground shadow',0,100,1],['sepia','Warmth',0,100,1],['hue','Hue',-180,180,1],['bright','Brightness',40,160,1],
  ['contrast','Contrast',40,160,1],['sat','Colour',0,200,1],['light','Model light',20,220,5]];
const PRESETS = {Ink:{sat:0,sepia:0,bright:100,contrast:110,hue:0}, Paper:{sat:70,sepia:35,bright:100,contrast:100,hue:0},
  Dusk:{sepia:40,hue:-20,bright:70,contrast:110,sat:90}, Mist:{mist:90,dblur:4,bright:112,contrast:75,sat:60,sepia:15,hue:0}};
const MSLIDERS = [['height','Grass height',0,100,1],['density','Density',5,100,1],['wind','Wind',0,100,1],['speed','Wind speed',0,100,1],['gust','Gusts',0,100,1],['dir','Wind direction',0,360,5],
  ['dry','Dryness',0,100,1],['rough','Terrain relief',0,100,1],['sun','Sun height',3,80,1],
  ['flowers','Wildflowers',0,100,1],['weeds','Weeds',0,100,1],['leaves','Fallen leaves',0,100,1],['fall','Drifting leaves',0,100,1],['clouds','Clouds',0,100,1],['wildlife','Wildlife (animals, birds)',0,100,1],['insects','Insects (low sun = fireflies)',0,100,1],
  ['pond','Pond life (lotus, lilies, reeds)',0,100,1],['weather','Weather (clear → rain)',0,100,1],['season','Season (spring→winter)',0,100,1]];
const BANDS = [[-1e9,300],[300,400],[400,500],[500,620],[620,1e9]], PAR = [.08,.22,.42,.7,1.1], BLUR = [1,.7,.4,.15,0], HAZE = [.8,.55,.35,.15], LW0 = 4200, LH0 = 700;
let LW = LW0, LH = LH0, lyEls = [], hzEls = [];
const sceneSave = () => { try{ localStorage.setItem('scene', JSON.stringify(SC)); }catch(e){} };
const ssi = $('#ssi'), back = $('#back'), fore = $('#fore');
const KINDS = {mountain:'Mountains', flowers:'Flowers', fish:'Fish', meadow:'Meadow (3D)'};
function ssiLoad(){
  if(!SC.seed) SC.seed = String(Math.floor(Math.random()*1e6));
  const sd = $('#seed'); if(sd) sd.value = SC.seed;
  const q = encodeURIComponent(SC.seed);
  ssi.src = SC.kind === 'flowers' ? `vendor/nonflowers/index.html?seed=${q}` : SC.kind === 'fish' ? `vendor/fishhost.html?${Date.now()}` : `vendor/shanshui.html?seed=${q}`;
}
const clearLayers = () => { $('#lys').innerHTML = ''; fore.innerHTML = ''; lyEls = []; hzEls = []; };
// all kinds fill #lys (far -> near) and #fore (nearest, drawn over the model) with .ly elements that sceneApply() moves for parallax
function hazeAndLayers(layerHtml, foreHtml){
  $('#lys').innerHTML = layerHtml.map((h, i) => `<div class="ly" data-i="${i + (layerHtml.length === 1 ? 2 : 0)}" style="width:${LW}px;height:${LH}px">${h}</div><div class="hz" data-i="${Math.min(i, 3)}"></div>`).join('');
  fore.innerHTML = foreHtml ? `<div class="ly" data-i="4" style="width:${LW}px;height:${LH}px">${foreHtml}</div>` : '';
  lyEls = [...document.querySelectorAll('#back .ly, #fore .ly')]; hzEls = [...document.querySelectorAll('#back .hz')];
  sceneApply();
}
function flowersBuild(tries = 0){                       // nonflowers paints one plant onto a canvas; hang that painting behind the model
  let w, cv; try{ w = ssi.contentWindow; cv = w.CTX?.canvas; }catch(e){}
  if(!cv || w.document.getElementById('loader').style.display !== 'none'){ if(tries < 120) setTimeout(() => flowersBuild(tries + 1), 250); return; }
  LW = cv.width; LH = cv.height;
  hazeAndLayers([`<img src="${cv.toDataURL('image/png')}" width="${LW}" height="${LH}" style="filter:drop-shadow(0 6px 14px rgba(40,30,10,.35))">`], '');
  hzEls.forEach(h => h.style.display = 'none');
}
function fishBuild(){                                    // fishdraw returns polylines; scatter fish over 5 depths, near ones big and in front
  const w = ssi.contentWindow; LW = LW0; LH = LH0;
  const rnd = (() => { let x = [...SC.seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) || 1; return () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296; })();
  const per = [3, 4, 4, 3, 3], size = [90, 150, 230, 340, 520], bands = per.map(() => '');
  per.forEach((n, i) => { for(let k = 0; k < n; k++){
    let pl; try{ pl = w.eval(`jsr = str_to_seed(${JSON.stringify(SC.seed + '-' + i + '-' + k)}); fish(generate_params())`); }catch(e){ continue; }
    const pts = pl.flat(), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), x0 = Math.min(...xs), y0 = Math.min(...ys), bw = Math.max(...xs) - x0, bh = Math.max(...ys) - y0;
    if(!(bw > 0 && bh > 0)) continue;
    const wpx = size[i] * (.8 + rnd() * .5), hpx = wpx * bh / bw, u = bw / wpx;
    const d = pl.map(l => 'M' + l.map(p => `${((p[0] - x0) / u).toFixed(1)} ${((p[1] - y0) / u).toFixed(1)}`).join('L')).join('');
    const x = rnd() * (LW - wpx), y = 120 + rnd() * (LH - 120 - hpx), flip = rnd() < .5 ? -1 : 1;
    bands[i] += `<svg class="fish" width="${wpx}" height="${hpx}" viewBox="0 0 ${wpx} ${hpx}" style="left:${x}px;top:${y}px;--d:${6 + rnd() * 9}s;--l:-${rnd() * 9}s"><path d="${d}" transform="${flip < 0 ? `translate(${wpx} 0) scale(-1 1)` : ''}" fill="none" stroke="rgba(60,60,60,.85)" stroke-width="${i < 2 ? 1 : 1.3}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  } });
  hazeAndLayers(bands.slice(0, 4), bands[4]);
}
function ssiLoaded(){
  if(SC.kind === 'flowers') flowersBuild();
  else if(SC.kind === 'fish') fishBuild();
  else setTimeout(layersBuild, 50);
}
function layersBuild(){
  let M; try{ M = ssi.contentWindow.MEM; }catch(e){}
  if(!M?.chunks?.length) return;
  LW = LW0; LH = LH0;
  const x0 = M.cursx - 600;
  const svg = ([a, b]) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} 0 ${LW} ${LH}" width="${LW}" height="${LH}">${M.chunks.filter(c => c.y >= a && c.y < b && c.x > x0 - M.cwid && c.x < x0 + LW + M.cwid).map(c => c.canv).join('')}</svg>`;
  hazeAndLayers(BANDS.slice(0, 4).map(svg), svg(BANDS[4]));
}
ssi.onload = ssiLoaded;
async function meadowApply(){                           // the 3D meadow lives only while Scene is on, kind = Meadow and a model is mounted
  const want = () => SC.on && SC.kind === 'meadow' && model && minfo;
  if(!want()){ if(insects){ insects.dispose(); insects = null; } if(fauna){ fauna.dispose(); fauna = null; } if(meadow){ meadow.dispose(); meadow = null; hemi.color.set(0xffffff); hemi.groundColor.set(0x555566); } return; }
  if(meadow) return;
  const {createMeadow} = await import('./meadow.js');
  if(meadow || !want()) return;
  meadow = createMeadow({scene, span:minfo.span, center:minfo.center, seed:SC.seed || '1', params:SC.meadow}); meadowSun(); sceneApply(); faunaApply(); insectsApply();
}
async function insectsApply(){                         // butterflies, dragonflies, fireflies
  if(!meadow || !SC.meadow.insects){ if(insects){ insects.dispose(); insects = null; } return; }
  if(!insects){ const {Insects} = await import('./insects.js'); if(insects || !meadow) return; insects = new Insects({scene, meadow, span:minfo.span, center:minfo.center, seed:SC.seed || '1', level:SC.meadow.insects}); }
  insects.setLevel(SC.meadow.insects); insects.setNight(1 - Math.min(1, Math.max(0, (SC.meadow.sun - 3) / 11)));
}
async function faunaApply(){                           // wildlife (animals + birds) lives inside the meadow
  if(!meadow || !SC.meadow.wildlife){ if(fauna){ fauna.dispose(); fauna = null; } return; }
  if(!fauna){ const {Fauna} = await import('./fauna.js'); if(fauna || !meadow) return; fauna = new Fauna({scene, meadow, span:minfo.span, center:minfo.center, seed:SC.seed || '1', level:SC.meadow.wildlife}); }
  fauna.setLevel(SC.meadow.wildlife);
}
function meadowSun(){                                   // the model's shadow light follows the meadow's sun
  if(!meadow || !sun) return;
  const m = meadow, e = Math.max(.05, m.sunDir.y);
  { const c = sun.shadow.camera, r = minfo.span * 2.8; Object.assign(c, {left:-r, right:r, top:r, bottom:-r}); c.updateProjectionMatrix(); }   // shadows reach the animals too
  hemi.color.copy(m.skyColor).lerp(new THREE.Color(1, 1, 1), .35); hemi.groundColor.copy(m.groundColor);
  sun.position.copy(minfo.center).addScaledVector(m.sunDir, minfo.span * 3.6); sun.color.copy(m.sunColor); sun.intensity = 2.6 * (.25 + .75 * Math.sqrt(e)) * (1 - .6 * SC.meadow.weather / 100);
}
function groundApply(){
  if(!ground) return;
  const on = SC.on && SC.shadow > 0 && SC.kind !== 'meadow';
  ground.visible = wash.visible = on; sun.visible = SC.on && (SC.kind === 'meadow' || SC.shadow > 0);
  ground.material.opacity = .6 * SC.shadow/100; wash.material.opacity = .55 * SC.shadow/100;
}
function sceneApply(){
  back.hidden = fore.hidden = !SC.on || SC.kind === 'meadow';
  scene.background = SC.on ? null : new THREE.Color($('#bg').value);
  const k = (SC.on ? SC.light : 100) / 100, mead = SC.on && SC.kind === 'meadow'; hemi.intensity = (mead ? 1.7 : 1.6)*k; key.intensity = (mead ? .3 : 2.2)*k;   // meadow: the sun does the lighting
  $('#bScene').classList.toggle('on', !$('#scenePanel').hidden);
  groundApply(); if(!!meadow !== (SC.on && SC.kind === 'meadow')) meadowApply();
  if(grid) grid.visible = $('#bGrid').classList.contains('on') && !SC.on;   // a grid on top of a painting looks wrong
  if(!SC.on || SC.kind === 'meadow') return;
  const look = `sepia(${SC.sepia}%) hue-rotate(${SC.hue}deg) brightness(${SC.bright}%) contrast(${SC.contrast}%) saturate(${SC.sat}%)`;
  $('#wash').style.background = SC.kind === 'fish' ? 'linear-gradient(#e4f0ee, #b9d3d6 60%, #8fb3bd)' : 'none';
  back.style.filter = look; fore.style.filter = look; fore.style.opacity = SC.fore/100;
  const w = stage.clientWidth, h = stage.clientHeight, sc = h/LH*SC.zoom, az = controls.getAzimuthalAngle(), pol = controls.getPolarAngle();
  for(const el of lyEls){
    const i = +el.dataset.i, bl = SC.dblur*BLUR[i];
    el.style.transform = `translate(${-(LW*sc - w)/2 - az*SC.parallax*3*PAR[i]}px, ${(h - LH*sc)/2 + SC.v - (pol - Math.PI/2)*SC.parallax*2*PAR[i]}px) scale(${sc})`;
    el.style.filter = bl ? `blur(${bl}px)` : '';
  }
  for(const el of hzEls) el.style.opacity = SC.mist/100 * HAZE[+el.dataset.i];
}
controls.addEventListener('change', () => SC.on && sceneApply());
new ResizeObserver(() => SC.on && sceneApply()).observe(stage);
function scenePanel(){
  $('#scenePanel').innerHTML = `<label><input type="checkbox" id="scOn" ${SC.on?'checked':''}> <b style="color:var(--fg)">Shan-shui scenery</b></label>
    <div class="r">${Object.entries(KINDS).map(([k, l]) => `<button data-kind="${k}" class="${SC.kind === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="r"><input id="seed" value="${SC.seed}" title="seed: same seed = same landscape"><button id="scGo">Go</button><button id="scDice" title="random landscape">🎲</button></div>
    <div class="r"><button id="scL">◀ scroll</button><button id="scR">scroll ▶</button></div>
    ${SC.kind === 'meadow' ? `<h4>Meadow</h4>${MSLIDERS.map(([k,l,a,b,st]) => `<label><span>${l}</span><input type="range" data-m="${k}" min="${a}" max="${b}" step="${st}" value="${SC.meadow[k]}"></label>`).join('')}<label><span>Model light</span><input type="range" data-k="light" min="20" max="220" step="5" value="${SC.light}"></label>`
    : `<h4>Look</h4><div class="r">${Object.keys(PRESETS).map(k => `<button data-p="${k}">${k}</button>`).join('')}<button id="scReset">Reset</button></div>
    ${SLIDERS.map(([k,l,a,b,st]) => `<label><span>${l}</span><input type="range" data-k="${k}" min="${a}" max="${b}" step="${st}" value="${SC[k]}"></label>`).join('')}`}
    <div style="color:var(--dim);font-size:11px;margin-top:6px">${SC.kind === 'meadow' ? 'Live 3D meadow: tufted grass, wildflowers, weeds, leaves, clouds. Wind-swept, parted by the model, real shadows. Same seed = same meadow.' : 'Five depth layers with parallax, haze and blur; the nearest ink drifts in front of the model; sun shadow + ink wash ground it. "Shot" saves the model on a transparent background.'}</div>`;
}
const scEnable = on => { SC.on = on; if(on && SC.kind !== 'meadow' && !ssi.getAttribute('src')) ssiLoad(); sceneSave(); sceneApply(); };
$('#bScene').onclick = () => { const p = $('#scenePanel'); p.hidden = !p.hidden; if(!p.hidden) scenePanel(); sceneApply(); };
$('#scenePanel').addEventListener('input', e => {
  if(e.target.id === 'scOn') return scEnable(e.target.checked);
  if(e.target.dataset.m){                               // meadow parameter
    const k = e.target.dataset.m; SC.meadow[k] = +e.target.value; sceneSave();
    if(k === 'wildlife'){ faunaApply(); return; }
    if(k === 'insects'){ insectsApply(); return; }
    if(k === 'rough'){ clearTimeout(window.__rt); window.__rt = setTimeout(() => { insects?.dispose(); insects = null; fauna?.dispose(); fauna = null; meadow?.dispose(); meadow = null; meadowApply(); }, 250); }
    else if(meadow){ meadow.setParams(SC.meadow); meadowSun(); if(k === 'sun') insectsApply(); }
    return;
  }
  const k = e.target.dataset.k; if(!k) return;
  SC[k] = +e.target.value; if(!SC.on) scEnable(true); sceneSave(); sceneApply();
});
$('#scenePanel').addEventListener('click', e => {
  const t = e.target;
  const reseed = () => { SC.on = true; sceneSave(); if(SC.kind === 'meadow'){ insects?.dispose(); insects = null; fauna?.dispose(); fauna = null; meadow?.dispose(); meadow = null; meadowApply(); } else ssiLoad(); };
  if(t.id === 'scGo'){ SC.seed = $('#seed').value || SC.seed; reseed(); }
  else if(t.id === 'scDice'){ SC.seed = String(Math.floor(Math.random()*1e6)); const sd = $('#seed'); if(sd) sd.value = SC.seed; reseed(); }
  else if(t.id === 'scL' || t.id === 'scR'){ try{ ssi.contentWindow.xcroll(t.id === 'scL' ? -300 : 300); layersBuild(); }catch(err){} }
  else if(t.dataset.kind){ SC.kind = t.dataset.kind; SC.on = true; clearLayers(); if(SC.kind !== 'meadow') ssiLoad(); sceneSave(); scenePanel(); }
  else if(t.dataset.p){ Object.assign(SC, PRESETS[t.dataset.p]); scEnable(true); scenePanel(); }
  else if(t.id === 'scReset'){ const keep = {on:SC.on, seed:SC.seed}; Object.assign(SC, SC_DEF, keep); sceneSave(); scenePanel(); }
  sceneApply();
});
if(SC.on) ssiLoad();

// ---------- routing + keys ----------
function route(){ const id = decodeURIComponent(location.hash.slice(1)); if(id) open(id); else setView('lib'); }
addEventListener('hashchange', route);
addEventListener('keydown', e => {
  if(e.key==='/' && document.activeElement!==$('#q') && view==='lib'){ e.preventDefault(); $('#q').focus(); return; }
  if(/INPUT|SELECT/.test(document.activeElement.tagName) && e.key!=='Escape') return;
  if(lb.style.display==='block'){ if(e.key==='Escape') lb.style.display='none'; if(e.key==='ArrowRight') lbShow(lbI+1); if(e.key==='ArrowLeft') lbShow(lbI-1); return; }
  if(view!=='viewer') return;
  const k = e.key.toLowerCase();
  if(e.key==='Escape') location.hash = '';
  else if(k==='r') $('#bReset').click(); else if(k==='w') $('#bWire').click(); else if(k==='c') $('#bClay').click();
  else if(k==='k') $('#bSkel').click(); else if(k==='e') $('#bScene').click(); else if(k==='g') $('#bGrid').click(); else if(k==='b') $('#bBox').click(); else if(k==='i') $('#bInsp').click();
  else if(k==='[') step(-1); else if(k===']') step(1);
  else if(k===' '){ e.preventDefault(); if(T.dur||T.audio) play(!T.playing); else $('#bRot').click(); }
  else if(e.key==='ArrowRight' && T.dur) setTime(T.t+5); else if(e.key==='ArrowLeft' && T.dur) setTime(T.t-5);
});

fetch('catalog.json').then(r => r.json()).then(d => d.items || []).catch(() => [])
  .then(d => { lib = d; renderLib(); route(); thumbQueue(); });
