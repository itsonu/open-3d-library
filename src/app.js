import * as THREE from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {FBXLoader} from 'three/addons/loaders/FBXLoader.js';
import {OBJLoader} from 'three/addons/loaders/OBJLoader.js';
import {MTLLoader} from 'three/addons/loaders/MTLLoader.js';
import {esc, cssUrl, ext, pickMain, buildBlobs, resolveBlob, texBlocked, planTextures, typeLabel, licenseBadge, BLANK_PNG} from './util.js';

const $ = s => document.querySelector(s);
const VIEW = ['glb','gltf','fbx','obj'], IMG = ['png','jpg','jpeg','webp','gif','bmp'], AUD = ['wav','mp3','ogg','m4a'];
const url = (it, n) => it.local ? (it.blobs.get(n.toLowerCase()) || BLANK_PNG) : `assets/${encodeURIComponent(it.id)}/${encodeURIComponent(n)}`;
const itemType = it => it.local ? 'Opened file' : typeLabel(it.type);
const totalSize = it => it.files.reduce((n, f) => n + (f.s || 0), 0);
// a url() inside a custom property resolves against the stylesheet, not the page: hand it an absolute URL
const cssImg = u => cssUrl(new URL(u, document.baseURI).href);
const mb = b => b > 1e6 ? (b/1e6).toFixed(1)+' MB' : Math.max(1,Math.round(b/1e3))+' KB';
const safeBase = u => { if(/^data:/i.test(u)) return ''; const b = String(u || '').split('?')[0].split('/').pop(); try{ return decodeURIComponent(b); }catch(e){ return b; } };
// toolbar helpers: disable a control with the reason as its tooltip (why = '' re-enables it and restores the original title)
function dis(el, why){ const t = el.closest('label') || el; el.disabled = !!why; t.dataset.t ??= t.title; t.title = why || t.dataset.t; }
const toggle = (id, fn) => $('#'+id).onclick = () => { const on = $('#'+id).getAttribute('aria-pressed') !== 'true'; $('#'+id).setAttribute('aria-pressed', on); fn(on); };
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
    const fin = () => { if(obj && idle && !fired){ fired = true; fixTextures(obj, it).catch(e => console.warn('texture repair failed', e)).then(() => resolve(obj)); } };
    const res = o => { obj = o; if(!pend) idle = true; fin(); setTimeout(() => { idle = true; fin(); }, 20000); };   // 20 s safety net
    const norm = n => n.toLowerCase().replace(/\.[^.]+$/,'').replace(/[^a-z0-9]/g,'');   // 'Material #18_Diffuse.png' ~ 'Material__18_Diffuse.jpeg'
    const names = new Map(it.files.filter(f => IMG.includes(ext(f.n))).map(f => [norm(f.n), f.n]));
    const mgr = new THREE.LoadingManager(() => { idle = true; fin(); });
    // FileLoader piggy-backs a request that is already in flight (e.g. the preview generator loading the same file) without telling the
    // manager, so such a load would never go idle: count what the manager actually started.
    let pend = 0; const is = mgr.itemStart, ie = mgr.itemEnd; mgr.itemStart = u => { pend++; is.call(mgr, u); }; mgr.itemEnd = u => { pend--; ie.call(mgr, u); };
    mgr.setURLModifier(u => {
      if(/^data:/i.test(u)) return u;
      if(texBlocked(u)) return BLANK_PNG;                  // never request .exr/.tif/.psd
      if(it.local) return resolveBlob(it.blobs, u);        // dropped files only: anything unmatched becomes a blank pixel, never a network request
      if(/^blob:/.test(u)) return u;
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
// materials just lack maps). Repair in order: 1) explicit per-model rules (item.textureOverrides), 2) planTextures() (util.js):
// match image sets by role (Substance 'cloth_Base_color_..', 'bodi_Diffuse') to material/mesh names, 3) drop any map whose image
// never arrived (it would render black).
async function fixTextures(obj, it){
  const imgs = it.files.filter(f => IMG.includes(ext(f.n)));
  const cache = {}, jobs = [];
  const tex = (f, srgb) => (cache[f.n] ??= new THREE.TextureLoader().loadAsync(url(it, f.n))).then(t => { t = t.clone(); t.name = f.n; t.needsUpdate = true; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; return t; });
  const put = (m, k, f) => jobs.push(tex(f, k==='map' || k==='emissiveMap').then(t => {
    m[k] = t; if(k==='map') m.vertexColors = false;
    if(k==='roughnessMap') m.roughness = 1; if(k==='metalnessMap') m.metalness = 1;      // the map is the value
    if(k==='emissiveMap' && !m.emissive.getHex()) m.emissive.set(0xffffff);
    if(k==='alphaMap') m.transparent = true;
    m.needsUpdate = true;
  }, () => {}));
  const byName = n => imgs.find(f => f.n === n);
  const fx = it.textureOverrides;
  const meshes = []; obj.traverse(o => o.isMesh && meshes.push(o));
  const done = new Set();                                   // materials set by an explicit rule are left alone below
  if(fx) for(const o of meshes){                            // rule value: an image file name, or a "#rrggbb" colour (for parts that have no texture at all)
    const v = fx[o.name] || fx['*'], f = byName(v);
    if(/^#/.test(v || '')) [].concat(o.material).forEach(m => { m.map = null; m.color.set(v); m.side = THREE.DoubleSide; m.needsUpdate = true; done.add(m); });
    else if(f) [].concat(o.material).forEach(m => { put(m, 'map', f); done.add(m); });
  }
  {
    const all = new Set(meshes.flatMap(o => [].concat(o.material)));
    const mats = [...all].filter(m => !done.has(m) && !m.map?.image);
    const users = m => meshes.filter(o => [].concat(o.material).includes(m)).map(o => o.name);
    const plan = planTextures(imgs.map(f => f.n), mats.map(m => ({name: m.name || '', meshes: users(m)})), all.size === 1);
    const toStandard = m => {                               // Phong/Lambert have no roughness/metalness maps
      const s = new THREE.MeshStandardMaterial();
      for(const k of ['name','color','emissive','side','transparent','opacity','alphaTest','vertexColors','wireframe','map','normalMap','bumpMap','aoMap','emissiveMap','alphaMap']) if(m[k] !== undefined) s[k]?.isColor ? s[k].copy(m[k]) : s[k] = m[k];
      for(const o of meshes) o.material = Array.isArray(o.material) ? o.material.map(x => x === m ? s : x) : o.material === m ? s : o.material;
      return s;
    };
    mats.forEach((m, i) => {
      const files = plan[i]; if(!files) return;
      if((files.roughnessMap || files.metalnessMap) && !m.isMeshStandardMaterial) m = toStandard(m);
      for(const [k, n] of Object.entries(files)){
        if(!(k in m) || m[k]?.image || (k==='bumpMap' && files.normalMap)) continue;   // unsupported by this material type, already has one, or a normal map wins over height
        put(m, k, byName(n));
      }
    });
  }
  await Promise.all(jobs);
  for(const o of meshes) for(const m of [].concat(o.material)){
    for(const k of ['map','normalMap','bumpMap','roughnessMap','metalnessMap','aoMap','emissiveMap','alphaMap','specularMap'])
      if(m[k] && !m[k].image){ m[k] = null; m.needsUpdate = true; }
    // FBX/OBJ exporters often write Phong with white specular and shininess 0: the highlight then covers the whole surface and
    // washes the model to white. No one authors that on purpose, so treat it as a matte surface with a faint, tight highlight.
    if(m.isMeshPhongMaterial && m.shininess < 2 && !m.specularMap){ m.specular.multiplyScalar(.04); m.shininess = 12; m.needsUpdate = true; }
  }
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
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov)/2) * Math.min(1, camera.aspect);   // the narrower of the vertical and horizontal fields of view, so portrait screens don't crop the model
  const d = Math.max(size.x, size.y, size.z) / (2*t) * 1.5 || 1;
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

const playIcon = on => { $('#tPlay use').setAttribute('href', on ? '#i-pause' : '#i-play'); $('#tPlay').setAttribute('aria-label', on ? 'Pause' : 'Play'); $('#tPlay').title = (on ? 'Pause' : 'Play') + ' (Space)'; };
function stopPlayback(){
  T.playing = false; T.t = 0; T.dur = 0; T.mixer?.stopAllAction(); T.mixer = T.action = null; T.actions = [];
  if(T.audio){ T.audio.pause(); T.audio.removeAttribute('src'); T.audio.load(); T.audio = null; }
  $('#tr').hidden = true; $('#viz').hidden = true; playIcon(false);
}
function setupTransport(it, obj){
  const clips = obj?.animations || [];
  if(clips.length){
    T.mixer = new THREE.AnimationMixer(obj);
    T.actions = clips.map(c => T.mixer.clipAction(c));
    $('#tClip').innerHTML = clips.map((c,i) => `<option value="${i}">${esc(c.name || 'clip '+(i+1))} (${fmt(c.duration)})</option>`).join('');
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
  T.playing = on; playIcon(on);
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
toggle('tLoop', on => T.loop = on);
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
  grid = new THREE.GridHelper(span*3, 30, 0x6b7280, 0x3b4150); grid.position.y = box.min.y; grid.visible = $('#oGrid').checked;
  grid.material.transparent = true; grid.material.opacity = .5;
  bbox = new THREE.Box3Helper(box, 0x6ea8ff); bbox.visible = $('#oBox').checked;
  scene.add(grid, bbox);
  const nBones = meshes.reduce((n, m) => n + (m.isSkinnedMesh ? m.skeleton.bones.length : 0), 0);
  if(nBones){ skel = new THREE.SkeletonHelper(model); skel.material.depthTest = false; skel.visible = $('#oSkel').checked; scene.add(skel); }
  else $('#oSkel').checked = false;
  dis($('#oSkel'), nBones ? '' : 'This model has no rig'); $('#skelWhy').textContent = nBones ? '' : '(no rig)';
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
  disposeModel(); $('#msg').textContent = ''; $('#err').hidden = true; showLoad(`Loading ${file.n}`, cur.thumb ? cssImg(cur.thumb) : 'none');
  fetchModelRetry(it, file, e => { if(my===token && !model && e.lengthComputable) loadPct(Math.round(e.loaded/e.total*100)); })
    .then(o => { if(my===token) mount(o); else disposeObj(o); })
    .catch(e => { if(my===token) showError(file, e, it); });
}
// loading overlay: file name + percentage (indeterminate until the server reports a length)
function showLoad(t, bg){ $('#loadT').textContent = t; $('#loadP').removeAttribute('value'); $('#loadPct').textContent = ''; $('#load').style.setProperty('--b', bg); $('#load').hidden = false; }
const loadPct = p => { $('#loadP').value = p; $('#loadPct').textContent = p + '%'; };
// load failure: a panel in the viewer with the reason and a way out (the loading overlay never stays up)
function showError(file, e, it){
  stopPlayback(); $('#load').hidden = true; $('#msg').textContent = '';
  const why = e?.message || e?.type || String(e);
  $('#errMsg').textContent = why + (it?.local ? '' : '  (is serve.py still running?)');
  $('#errFile').textContent = file.n; $('#err').hidden = false;
}

function open(id){
  const it = [...locals, ...lib].find(i => i.id===id);
  if(!it){ setView('lib'); history.replaceState(null, '', location.pathname + location.search); showNotice(`Asset not found: ${id}`); return; }
  $('#notice').hidden = true;
  if(it.sensitive && passed !== id){ setView('lib'); askAge(id); return; }
  setView('viewer'); cur = it; token++; disposeModel(); $('#err').hidden = true;
  dis($('#bPrev'), it.local && 'Previous/next only work for library assets'); dis($('#bNext'), it.local && 'Previous/next only work for library assets');
  $('#title').textContent = `${itemType(it)} / ${it.name}`;
  document.title = `${it.name} · Open 3D Library`;
  const models = it.files.filter(f => VIEW.includes(ext(f.n))).sort((a,b) => VIEW.indexOf(ext(a.n)) - VIEW.indexOf(ext(b.n)));
  const imgs = it.files.filter(f => IMG.includes(ext(f.n)));
  const fsel = $('#fsel'), g = $('#gallery');
  fsel.hidden = models.length < 2; fsel.innerHTML = models.map(f => `<option>${esc(f.n)}</option>`).join('');
  const vmds = it.files.filter(f => ext(f.n)==='vmd').sort((a,b) => /cnv/i.test(a.n) - /cnv/i.test(b.n));
  const mocap = !models.length && vmds.length > 0;           // a VMD with no model: play it on the built-in mannequin (vmdplayer.js)
  if(mocap){ fsel.hidden = vmds.length < 2; fsel.innerHTML = vmds.map(f => `<option>${esc(f.n)}</option>`).join(''); }
  const is3d = models.length > 0 || mocap, isGal = !is3d && it.type==='reference' && imgs.length;
  $('#center').firstElementChild.style.display = isGal ? 'none' : ''; g.style.display = isGal ? 'grid' : 'none';
  document.querySelectorAll('#hView [data-3d]').forEach(el => dis(el, !is3d && 'No 3D view for this asset'));
  dis($('#oSkel'), is3d ? 'This model has no rig' : 'No 3D view for this asset'); $('#skelWhy').textContent = '';
  $('#load').hidden = true; $('#msg').textContent = '';
  inspector();
  if(isGal){
    g.innerHTML = imgs.map((f,i) => `<figure data-i="${i}" tabindex="0" role="button" aria-label="View ${esc(f.n)}"><img loading="lazy" src="${esc(f.t || url(it,f.n))}" data-full="${esc(url(it,f.n))}" alt=""><figcaption>${esc(f.n)}</figcaption></figure>`).join('');
    g.onclick = e => { const f = e.target.closest('figure'); if(f) lightbox(imgs.map(x => url(it,x.n)), +f.dataset.i); };
    g.onkeydown = e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); e.target.click(); } };
  } else if(mocap) loadMocap(it, vmds[0]);
  else if(is3d) loadModel(it, models[0]);
  else { setupTransport(it, null); vmdInfo(it); }
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
  disposeModel(); $('#msg').textContent = ''; $('#err').hidden = true; showLoad(`Reading ${file.n}`, 'none');
  fetch(url(it, file.n)).then(r => { if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }).then(buf => import('./vmdplayer.js').then(m => m.buildMannequin(buf)))
    .then(o => { if(my===token) mount(o); else disposeObj(o); })
    .catch(e => { if(my===token) showError(file, e, it); });
}
$('#fsel').onchange = e => { const f = cur.files.find(f => f.n===e.target.value); ext(f.n)==='vmd' ? loadMocap(cur, f) : loadModel(cur, f); };

// ---------- inspector ----------
const sec = (title, n, body, open = true) => `<details class="sec" ${open ? 'open' : ''}><summary>${title}${n == null ? '' : ` <span class="n">${n}</span>`}</summary>${body}</details>`;
const row = (k, v) => `<div class="row"><span class="k">${k}</span><span>${v}</span></div>`;      // v is HTML: callers esc() data
const kv = (k, v) => v ? `<div class="kv"><span class="k">${k}</span><span>${v}</span></div>` : '';
function assetInfo(it){                                                                   // catalogue metadata: only the fields that exist
  const src = String(it.source || ''), tags = [].concat(it.tags || []);
  return row('Name', esc(it.name)) + row('Type', esc(itemType(it)))
    + (it.description ? `<p class="desc">${esc(it.description)}</p>` : '') + kv('Author', esc(it.author)) + kv('Licence', esc(it.license))
    + kv('Source', /^https?:\/\//i.test(src) ? `<a href="${esc(src)}" target="_blank" rel="noopener noreferrer">${esc(src.replace(/^https?:\/\//i, '').replace(/\/$/, ''))}</a>` : esc(src))
    + (tags.length ? `<div class="tags">${tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : '');
}
function inspector(size){
  let h = sec('Asset', null, assetInfo(cur) + (cur.collection === 'local' ? `<p class="muted">${esc('Local collection — not part of the public library')}</p>` : ''));
  if(model){
    let tris = 0, verts = 0; const mats = new Set(), tex = new Set();
    for(const m of meshes){
      const g = m.geometry; verts += g.attributes.position.count; tris += (g.index ? g.index.count : g.attributes.position.count)/3;
      for(const mat of [].concat(m.userData.m0)){ mats.add(mat); Object.entries(mat).forEach(([k,v]) => v?.isTexture && tex.add(k+': '+(v.name || cur.rev?.get(v.image?.src) || safeBase(v.image?.src) || 'embedded'))); }
    }
    const nBones = meshes.reduce((n, m) => n + (m.isSkinnedMesh ? m.skeleton.bones.length : 0), 0), clips = model.animations || [];
    const usedKeys = new Set([...tex].map(t => t.split(': ').slice(1).join(': ').toLowerCase().replace(/\.[^.]+$/,'').replace(/[^a-z0-9]/g,'')));
    const unused = cur.files.filter(f => IMG.includes(ext(f.n)) && !/^gltf_embedded/.test(f.n) && !usedKeys.has(f.n.toLowerCase().replace(/\.[^.]+$/,'').replace(/[^a-z0-9]/g,''))).map(f => f.n);
    const sz = size ? [size.x,size.y,size.z].map(v => +v.toPrecision(3)).join(' × ') : '';
    h += sec('Model stats', null, row('Meshes', meshes.length) + row('Triangles', Math.round(tris).toLocaleString()) + row('Vertices', verts.toLocaleString()) + row('Materials', mats.size)
      + row('Textures', tex.size) + row('Rig', nBones ? nBones + ' bones' : 'none') + row('Animations', clips.length) + row('Size (scene units)', esc(sz)));
    if(clips.length) h += sec('Animations', clips.length, clips.map((c,i) => `<div class="mesh" data-clip="${i}"><button class="plain" title="Play ${esc(c.name || 'clip '+(i+1))}">▶ ${esc(c.name || 'clip '+(i+1))}</button><small class="muted">${fmt(c.duration)}</small></div>`).join(''));
    else if(nBones) h += '<p class="muted note">Rigged (turn on Bones under Overlays to see the skeleton) but has no animation clips.</p>';
    h += sec('Meshes', meshes.length, `<p class="muted note">Click a name to select, tick to show or hide.</p><div id="meshes">${meshes.map((m,i) =>
      `<div class="mesh" data-i="${i}"><input type="checkbox" checked data-v="${i}" aria-label="Show ${esc(m.name || 'mesh '+i)}"><button class="plain" aria-pressed="false" title="${esc(m.name)}">${esc(m.name||'mesh '+i)}</button></div>`).join('')}</div>`)
      + sec('Selected', null, '<div id="selinfo"><span class="muted">nothing</span></div>')
      + sec('Textures applied', tex.size, tex.size ? `<ul class="list">${[...tex].map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p class="muted">none</p>', false)
      + (unused.length ? sec('Unused image files', unused.length, `<ul class="list">${unused.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`, false) : '');
  }
  h += sec('Files', cur.files.length, `<div class="files">${cur.files.map(f => `<div><a href="${esc(url(cur,f.n))}" download title="${esc(f.n)}">${esc(f.n)}</a><small>${mb(f.s)}</small></div>`).join('')}</div>`);
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
  document.querySelectorAll('.mesh[data-i]').forEach(r => { const on = !!m && meshes[+r.dataset.i]===m; r.classList.toggle('sel', on); r.querySelector('button').setAttribute('aria-pressed', on); });
  if(!m){ $('#selinfo') && ($('#selinfo').innerHTML = '<span class="muted">nothing</span>'); return; }
  sel.box = new THREE.BoxHelper(m, 0xffd166); scene.add(sel.box);
  const g = m.geometry, mats = [].concat(m.userData.m0);
  $('#selinfo').innerHTML = row('Name', esc(m.name||'(unnamed)')) + row('Triangles', Math.round((g.index?g.index.count:g.attributes.position.count)/3).toLocaleString()) + row('Material', mats.map(x=>esc(x.name||'(unnamed)')).join(', '));
}
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2(); let down = null;
const pick = e => { const r = renderer.domElement.getBoundingClientRect(); ptr.set((e.clientX-r.left)/r.width*2-1, -((e.clientY-r.top)/r.height)*2+1); ray.setFromCamera(ptr, camera); return ray.intersectObjects(meshes.filter(m=>m.visible), false)[0]; };
renderer.domElement.addEventListener('pointerdown', e => down = [e.clientX, e.clientY]);
renderer.domElement.addEventListener('pointerup', e => { if(down && Math.hypot(e.clientX-down[0], e.clientY-down[1]) < 4 && model){ select(pick(e)?.object||null); } });
renderer.domElement.addEventListener('dblclick', e => { const h = pick(e); if(h){ select(h.object); frame(new THREE.Box3().setFromObject(h.object), true); } });

// ---------- toolbar ----------
$('#bReset').onclick = () => { if(!home) return; camera.position.copy(home.pos); controls.target.copy(home.tgt); camera.near = home.near; camera.far = home.far; camera.updateProjectionMatrix(); controls.update(); };
const zoom = f => camera.position.sub(controls.target).multiplyScalar(f).add(controls.target);
$('#bIn').onclick = () => zoom(.8); $('#bOut').onclick = () => zoom(1.25);
toggle('bRot', on => controls.autoRotate = on);
function setMode(m){ flags.clay = m === 'clay'; flags.wire = m === 'wire'; $(`[name=mode][value=${m}]`).checked = true; applyMode(); }
document.querySelectorAll('[name=mode]').forEach(r => r.onchange = () => setMode(r.value));
$('#oGrid').onchange = e => grid && (grid.visible = e.target.checked && !SC.on);
$('#oBox').onchange = e => bbox && (bbox.visible = e.target.checked);
$('#oSkel').onchange = e => skel && (skel.visible = e.target.checked);
// inspector: a side panel on desktop, a bottom sheet below 768 px (closed there until asked for)
const narrow = matchMedia('(max-width:767.98px)');
function setInsp(on){ $('#viewer').classList.toggle('noinsp', !on); $('#bInsp').setAttribute('aria-pressed', on); resize(); }
$('#bInsp').onclick = () => setInsp($('#bInsp').getAttribute('aria-pressed') !== 'true');
$('#bDet').onclick = () => setInsp(true); $('#bDetX').onclick = () => { setInsp(false); $('#bDet').focus(); };
if(narrow.matches) setInsp(false);
// popovers: Overlays (wide) and More (narrow); one open at a time, click outside or Esc closes
const POP = {bOv: 'ovMenu', bMore: 'more'};
function pop(b, on = $('#'+b).getAttribute('aria-expanded') !== 'true'){
  if(on) for(const k in POP) if(k !== b) pop(k, false);
  $('#'+b).setAttribute('aria-expanded', on); $('#'+POP[b]).classList.toggle('open', on);
}
const openPop = () => Object.keys(POP).find(k => $('#'+k).getAttribute('aria-expanded') === 'true');
$('#bOv').onclick = () => pop('bOv'); $('#bMore').onclick = () => pop('bMore');
document.addEventListener('click', e => {
  if(!e.target.closest('.pw, #bMore')) pop('bOv', false);
  if(!e.target.closest('#more, #bMore') || (e.target.closest('#more button') && !e.target.closest('.pw'))) pop('bMore', false);
});
$('#bg').onchange = () => sceneApply();
$('#bShot').onclick = () => { renderer.render(scene, camera); renderer.domElement.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = (cur?.id||'shot')+'.png'; a.click(); }); };
$('#bBack').onclick = () => location.hash = '';
const step = d => { if(cur?.local || !lib.length) return; const i = lib.indexOf(cur), n = lib[(i+d+lib.length)%lib.length]; location.hash = n.id; };
$('#bPrev').onclick = () => step(-1); $('#bNext').onclick = () => step(1);

// ---------- lightbox ----------
const lb = $('#lb'), lbImg = lb.querySelector('img'); let lbList = [], lbI = 0, S = {s:1,x:0,y:0};
const lbApply = () => lbImg.style.transform = `translate(${S.x}px,${S.y}px) scale(${S.s}) translate(-50%,-50%)`;
function lbShow(i){ lbI = (i+lbList.length)%lbList.length; lbImg.src = lbList[lbI]; S = {s:1,x:innerWidth/2,y:innerHeight/2}; lbImg.style.left = lbImg.style.top = '0'; lbApply(); }
function lightbox(list, i){ lbList = list; lb.style.display = 'block'; lbShow(i); lb.focus(); }
lb.addEventListener('wheel', e => { e.preventDefault(); const f = e.deltaY<0 ? 1.15 : 1/1.15; S.x = e.clientX-(e.clientX-S.x)*f; S.y = e.clientY-(e.clientY-S.y)*f; S.s *= f; lbApply(); }, {passive:false});
let drag = null, moved = false;
lb.onpointerdown = e => { drag = [e.clientX-S.x, e.clientY-S.y]; moved = false; lb.setPointerCapture(e.pointerId); lb.style.cursor = 'grabbing'; };
lb.onpointermove = e => { if(drag){ moved = true; S.x = e.clientX-drag[0]; S.y = e.clientY-drag[1]; lbApply(); } };
lb.onpointerup = e => { drag = null; lb.style.cursor = 'grab'; if(!moved && e.target===lb) lb.style.display = 'none'; };
lb.ondblclick = () => lbShow(lbI);

// ---------- library (visual grid) ----------
let lib = [], filter = 'all', locals = [];
let passed = null;                                          // the one item the user just confirmed; asked again next time
function askAge(id){
  const g = $('#gate'); g.showModal();
  $('#gYes').onclick = () => { passed = id; g.close(); open(id); };
  $('#gNo').onclick = () => { g.close(); location.hash = ''; };
  g.oncancel = () => { location.hash = ''; };                      // Esc = no
}
let libDirty = false;
function setView(v){
  view = v; pop('bOv', false); pop('bMore', false); $('#lib').hidden = $('#hLib').hidden = v!=='lib'; $('#viewer').hidden = $('#hView').hidden = v!=='viewer';
  if(v==='lib'){ document.title = 'Open 3D Library'; disposeModel(); cur = null; passed = null; $('#err').hidden = true; if(libDirty) renderLib(); }
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
  const ph = m ? '' : tag.toUpperCase(), lic = licenseBadge(it.license);
  const ad = it.sensitive;                  // thumbnails of these stay blurred always
  return `<a class="card ${ad ? 'adult' : ''}" href="#${esc(encodeURIComponent(it.id))}" data-id="${esc(it.id)}">${ad ? '<span class="badge">18+</span>' : ''}${it.collection === 'local' ? '<span class="badge local">Local</span>' : ''}<div class="th ${!th && m ? 'q' : ''}" data-th="${esc(it.id)}" ${th ? `style="--b:${esc(cssImg(th))}"` : ''}>${th ? `<img loading="lazy" src="${esc(th)}" alt="">` : `<span class="ph">${esc(ph)}</span>`}${!th && m ? '<div class="gen">making preview…</div>' : ''}</div>
    <div class="meta"><b title="${esc(it.name)}">${esc(it.name)}</b><span class="sub"><span>${esc(itemType(it))}</span><span>${esc(tag.toUpperCase())}</span><span>${esc(mb(totalSize(it)))}</span></span><span class="lic" ${it.license ? `title="${esc(it.license)}"` : ''}>${esc(lic)}</span></div></a>`;
}
let layout = 'grid', sort = 'name';
const BY_NAME = (a, b) => a.name.localeCompare(b.name, 'en', {numeric: true});
const SORTS = {name: BY_NAME, type: (a, b) => typeLabel(a.type).localeCompare(typeLabel(b.type)) || BY_NAME(a, b), size: (a, b) => totalSize(b) - totalSize(a) || BY_NAME(a, b)};
const LIST_HEAD = '<div class="lh" aria-hidden="true"><span></span><span>Name</span><span>Type</span><span>Format</span><span>Size</span><span>Licence</span></div>';
function renderLib(){
  libDirty = false;
  const q = $('#q').value.trim().toLowerCase(), st = $('#lib').scrollTop;
  const types = [...new Set(lib.map(i => i.type))].sort((a, b) => typeLabel(a).localeCompare(typeLabel(b)));
  if(filter !== 'all' && !types.includes(filter)) filter = 'all';
  $('#chips').innerHTML = types.length ? [['all', 'All', lib.length], ...types.map(t => [t, typeLabel(t), lib.filter(i => i.type === t).length])]
    .map(([t, l, n]) => `<button class="chip" data-t="${esc(t)}" aria-pressed="${filter === t}">${esc(l)} <span class="n">${n}</span></button>`).join('') : '';
  const section = (h, list) => `<h2>${esc(h)} · ${list.length}</h2><div class="${layout}">${layout === 'list' ? LIST_HEAD : ''}${list.map(card).join('')}</div>`;
  let out = locals.length ? section('Opened files', locals) : '';   // this session only
  const items = lib.filter(i => (filter === 'all' || i.type === filter) && (i.name + ' ' + typeLabel(i.type)).toLowerCase().includes(q)).sort(SORTS[sort]);
  if(items.length){
    if(sort === 'type') for(const t of types){ const g = items.filter(i => i.type === t); if(g.length) out += section(typeLabel(t), g); }
    else out += section(filter === 'all' ? 'All assets' : typeLabel(filter), items);
  }
  if(!out) out = lib.length ? '<p class="muted">Nothing matches.</p>' : '<div class="empty"><p>No assets in the library yet.</p><button data-open>Open…</button><p>Drop files or a folder here</p></div>';
  $('#lib').innerHTML = out; $('#lib').scrollTop = st;
  $('#lib').querySelectorAll('.th img').forEach(i => i.complete && i.classList.add('ld'));
}
$('#lib').addEventListener('load', e => e.target.classList?.add('ld'), true);          // load/error don't bubble: capture them on the container
$('#gallery').addEventListener('error', e => { const i = e.target; if(i.dataset?.full && i.getAttribute('src') !== i.dataset.full) i.src = i.dataset.full; }, true);   // thumbnail missing -> the full image
$('#chips').onclick = e => { const t = e.target.closest('[data-t]')?.dataset.t; if(t){ filter = t; renderLib(); $(`#chips [data-t="${CSS.escape(t)}"]`)?.focus(); } };
$('#lib').onclick = e => { if(e.target.closest('[data-open]')) fileIn.click(); };
$('#sort').onchange = e => { sort = e.target.value; renderLib(); };
document.querySelectorAll('[name=lay]').forEach(r => r.onchange = () => { layout = r.value; $('#cwl').hidden = layout !== 'grid'; renderLib(); });
$('#q').oninput = renderLib;
$('#cw').oninput = e => document.documentElement.style.setProperty('--cw', e.target.value+'px');

// ---------- notices + opening local files (Open… button, `o`, drag-and-drop of files or folders) ----------
const fileIn = $('#fileIn');
const showNotice = t => { $('#notice span').textContent = t; $('#notice').hidden = false; };
$('#nClose').onclick = () => $('#notice').hidden = true;
$('#bOpenLib').onclick = $('#bOpen').onclick = $('#eOpen').onclick = () => fileIn.click();
$('#eBack').onclick = () => location.hash = '';
const SUPPORT = new Set([...VIEW, ...IMG, ...AUD, 'bin', 'mtl', 'vmd', 'tga']);
const MAX_LOCAL = 5; let localN = 0;
// files: [{path, file}] -> a transient item that lives only in this session (blob URLs, revoked when it falls out of the last 5)
function openFiles(files){
  const ok = files.filter(f => SUPPORT.has(ext(f.path))), main = pickMain(ok.map(f => ({n: f.path})));
  if(!main){
    const got = files.slice(0, 8).map(f => f.path).join(', ') + (files.length > 8 ? ` and ${files.length - 8} more` : '');
    return showNotice(`No viewable file in this selection.\nSupported: GLB/glTF, FBX, OBJ+MTL, VMD motion.\nReceived: ${got || 'nothing'}`);
  }
  const urls = ok.map(f => ({path: f.path, url: URL.createObjectURL(f.file)}));
  const tops = new Set(ok.map(f => f.path.includes('/') ? f.path.split('/')[0] : ''));
  const it = {id: 'local-' + ++localN, type: 'local', name: tops.size === 1 && [...tops][0] || main.n.split('/').pop().replace(/\.[^.]+$/, ''),
    files: ok.map(f => ({n: f.path, s: f.file.size})), local: true, blobs: buildBlobs(urls), rev: new Map(urls.map(u => [u.url, u.path]))};
  locals.unshift(it);
  while(locals.length > MAX_LOCAL) new Set(locals.pop().blobs.values()).forEach(u => URL.revokeObjectURL(u));
  libDirty = true; thumbQueue(); location.hash = it.id;
}
fileIn.onchange = () => { openFiles([...fileIn.files].map(file => ({path: file.webkitRelativePath || file.name, file}))); fileIn.value = ''; };
async function readDrop(dt){                                 // entries must be taken synchronously, before the first await
  const ents = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean), out = []; let budget = 5000;
  if(!ents.length) return [...dt.files].map(file => ({path: file.name, file}));
  const walk = async en => {
    if(budget-- <= 0) return;
    if(en.isFile) out.push({path: en.fullPath.replace(/^\//, ''), file: await new Promise((r, j) => en.file(r, j))});
    else for(const rd = en.createReader(), more = () => new Promise((r, j) => rd.readEntries(r, j)); ;){ const b = await more(); if(!b.length) break; for(const c of b) await walk(c); }
  };
  for(const en of ents) await walk(en);
  return out;
}
let dragN = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', e => { if(hasFiles(e)){ e.preventDefault(); dragN++; $('#drop').hidden = false; } });
addEventListener('dragover', e => { if(hasFiles(e)){ e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
addEventListener('dragleave', e => { if(hasFiles(e) && --dragN <= 0){ dragN = 0; $('#drop').hidden = true; } });
addEventListener('drop', async e => {
  if(!hasFiles(e)) return;
  e.preventDefault(); dragN = 0; $('#drop').hidden = true;
  try{ openFiles(await readDrop(e.dataTransfer)); }catch(err){ showNotice(`Couldn't read the dropped files: ${err?.message || err}`); }
});

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
let tq = null; const tried = new Set();
const thumbQueue = () => tq ??= makeThumbs().finally(() => tq = null);
async function makeThumbs(){
  let n = 0;
  for(;;){
    const todo = [...locals, ...lib].filter(i => !tried.has(i) && !thumbOf(i) && pickModel(i)).sort((a,b) => pickModel(a).s - pickModel(b).s), it = todo[0];
    if(!it) break;
    tried.add(it);
    while(view==='viewer' || location.hash.length > 1) await sleep(1000);          // stay out of the way while a model is open (or about to be)
    $('#status').textContent = `making previews ${++n}/${n - 1 + todo.length}`;
    try{
      const blob = await makeThumb(it);
      if(!it.local) fetch(`thumb/${it.id}.jpg`, {method:'POST', headers:{'X-O3DL':'1'}, body:blob}).catch(() => {});   // opened files stay in the browser
      it.thumb = URL.createObjectURL(blob);
      const th = document.querySelector(`[data-th="${CSS.escape(it.id)}"]`);
      if(th){ th.style.setProperty('--b', cssImg(it.thumb)); th.replaceChildren(Object.assign(new Image(), {src:it.thumb, onload(){ this.classList.add('ld'); }})); }
    }catch(e){ console.warn('preview failed', it.id, e); const th = document.querySelector(`[data-th="${CSS.escape(it.id)}"]`); th?.classList.remove('q'); th?.querySelector('.gen')?.remove(); }
    await sleep(50);
  }
  $('#status').textContent = '';
}

window.mv = {THREE, renderer, scene, frame, controls, camera, get meadow(){ return meadow; }, get fauna(){ return fauna; }, get insects(){ return insects; }, get meshes(){ return meshes; }, get cur(){ return cur; }, get locals(){ return locals; }, openFiles};   // console handle for debugging

// ---------- scenery backdrop: shan-shui-inf (MIT, see shanshui-LICENSE.txt) ----------
// The engine runs in a hidden iframe (it overrides Math.random). Its generated chunks are regrouped by depth into 5 layers that
// get their own parallax, blur and haze, so the scenery has real distance. The nearest layer is drawn OVER the model's feet.
const MEADOW_DEF = {height:50, density:70, wind:45, speed:50, gust:35, dir:35, dry:25, rough:35, sun:42, flowers:70, weeds:70, leaves:60, fall:60, clouds:45, wildlife:45, insects:55, weather:0, season:33, pond:70};
const SC_DEF = {meadow:{...MEADOW_DEF}, on:false, kind:'mountain', seed:'', zoom:1.3, v:0, parallax:40, mist:55, dblur:2, fore:60, shadow:45, sepia:25, hue:0, bright:100, contrast:100, sat:100, light:100};
const SC = {...SC_DEF, meadow:{...MEADOW_DEF}}; try{ Object.assign(SC, JSON.parse(localStorage.getItem('scene') || '{}')); }catch(e){}
SC.meadow = {...MEADOW_DEF, ...SC.meadow};                // fill in params added since the settings were saved
// [key, label, min, max, step, group]: the panel shows a small heading whenever the group changes
const SLIDERS = [['zoom','Zoom',.8,3,.05,'Composition'],['v','Vertical',-300,300,5,'Composition'],['parallax','Parallax',0,100,1,'Composition'],
  ['mist','Distance haze',0,100,1,'Depth'],['dblur','Depth blur',0,8,.5,'Depth'],['fore','Foreground ink',0,100,1,'Depth'],['shadow','Ground shadow',0,100,1,'Depth'],
  ['sepia','Warmth',0,100,1,'Colour & tone'],['hue','Hue',-180,180,1,'Colour & tone'],['bright','Brightness',40,160,1,'Colour & tone'],['contrast','Contrast',40,160,1,'Colour & tone'],['sat','Colour',0,200,1,'Colour & tone'],
  ['light','Model light',20,220,5,'Lighting']];
const PRESETS = {Ink:{sat:0,sepia:0,bright:100,contrast:110,hue:0}, Paper:{sat:70,sepia:35,bright:100,contrast:100,hue:0},
  Dusk:{sepia:40,hue:-20,bright:70,contrast:110,sat:90}, Mist:{mist:90,dblur:4,bright:112,contrast:75,sat:60,sepia:15,hue:0}};
const MSLIDERS = [['height','Grass height',0,100,1,'Terrain & grass'],['density','Density',5,100,1,'Terrain & grass'],['rough','Terrain relief',0,100,1,'Terrain & grass'],['dry','Dryness',0,100,1,'Terrain & grass'],
  ['wind','Wind',0,100,1,'Terrain & grass'],['speed','Wind speed',0,100,1,'Terrain & grass'],['gust','Gusts',0,100,1,'Terrain & grass'],['dir','Wind direction',0,360,5,'Terrain & grass'],
  ['flowers','Wildflowers',0,100,1,'Plants'],['weeds','Weeds',0,100,1,'Plants'],['leaves','Fallen leaves',0,100,1,'Plants'],['fall','Drifting leaves',0,100,1,'Plants'],
  ['pond','Pond life (lotus, lilies, reeds)',0,100,1,'Water'],
  ['sun','Sun height',3,80,1,'Sky & weather'],['clouds','Clouds',0,100,1,'Sky & weather'],['weather','Weather (clear → rain)',0,100,1,'Sky & weather'],['season','Season (spring→winter)',0,100,1,'Sky & weather'],
  ['wildlife','Wildlife (animals, birds)',0,100,1,'Wildlife & insects'],['insects','Insects (low sun = fireflies)',0,100,1,'Wildlife & insects'],
  ['light','Model light',20,220,5,'Lighting']];
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
  $('#lys').innerHTML = layerHtml.map((h, i) => `<div class="ly" data-i="${i + (layerHtml.length === 1 ? 2 : 0)}" style="width:${+LW}px;height:${+LH}px">${h}</div><div class="hz" data-i="${Math.min(i, 3)}"></div>`).join('');
  fore.innerHTML = foreHtml ? `<div class="ly" data-i="4" style="width:${+LW}px;height:${+LH}px">${foreHtml}</div>` : '';
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
const meadowRebuild = () => { insects?.dispose(); insects = null; fauna?.dispose(); fauna = null; meadow?.dispose(); meadow = null; meadowApply(); };
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
  $('#bScene').setAttribute('aria-expanded', !$('#scenePanel').hidden);
  groundApply(); if(!!meadow !== (SC.on && SC.kind === 'meadow')) meadowApply();
  if(grid) grid.visible = $('#oGrid').checked && !SC.on;   // a grid on top of a painting looks wrong
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
  const meadowKind = SC.kind === 'meadow', list = meadowKind ? MSLIDERS : SLIDERS; let grp = '';
  const sliders = list.map(([k,l,a,b,st,g]) => {
    const m = meadowKind && k !== 'light', head = g !== grp ? `<h3>${esc(grp = g)}</h3>` : '';
    return `${head}<label><span>${esc(l)}</span><input type="range" data-${m ? 'm' : 'k'}="${esc(k)}" min="${a}" max="${b}" step="${st}" value="${esc(m ? SC.meadow[k] : SC[k])}"></label>`;
  }).join('');
  $('#scenePanel').innerHTML = `<div class="sp-head"><h2>Scene</h2><button id="scClose" class="ghost icon" title="Close (Esc)" aria-label="Close scene panel"><svg class="i"><use href="#i-close"/></svg></button></div>
    <label><input type="checkbox" id="scOn" ${SC.on?'checked':''}> <b>Use scene backdrop</b></label>
    <div class="r" role="group" aria-label="Backdrop type">${Object.entries(KINDS).map(([k, l]) => `<button data-kind="${esc(k)}" aria-pressed="${SC.kind === k}">${esc(l)}</button>`).join('')}</div>
    <div class="r"><input id="seed" aria-label="Seed: same seed, same landscape" value="${esc(SC.seed)}" title="seed: same seed = same landscape"><button id="scGo">Go</button><button id="scDice" title="Random landscape" aria-label="Random landscape">🎲</button></div>
    <div class="r"><button id="scL">◀ scroll</button><button id="scR">scroll ▶</button></div>
    ${meadowKind ? '' : `<h3>Presets</h3><div class="r">${Object.keys(PRESETS).map(k => `<button data-p="${esc(k)}">${esc(k)}</button>`).join('')}</div>`}
    ${sliders}
    <div class="r"><button id="scReset">Reset to defaults</button></div>
    <p class="note muted">${meadowKind ? 'Live 3D meadow: tufted grass, wildflowers, weeds, leaves, clouds. Wind-swept, parted by the model, real shadows. Same seed = same meadow.' : 'Five depth layers with parallax, haze and blur; the nearest ink drifts in front of the model; sun shadow + ink wash ground it. "Shot" saves the model on a transparent background.'}</p>`;
}
const scEnable = on => { SC.on = on; if(on && SC.kind !== 'meadow' && !ssi.getAttribute('src')) ssiLoad(); sceneSave(); sceneApply(); };
$('#bScene').onclick = () => { const p = $('#scenePanel'); p.hidden = !p.hidden; if(!p.hidden) scenePanel(); sceneApply(); };
$('#scenePanel').addEventListener('input', e => {
  if(e.target.id === 'scOn') return scEnable(e.target.checked);
  if(e.target.dataset.m){                               // meadow parameter
    const k = e.target.dataset.m; SC.meadow[k] = +e.target.value; sceneSave();
    if(k === 'wildlife'){ faunaApply(); return; }
    if(k === 'insects'){ insectsApply(); return; }
    if(k === 'rough'){ clearTimeout(window.__rt); window.__rt = setTimeout(meadowRebuild, 250); }
    else if(meadow){ meadow.setParams(SC.meadow); meadowSun(); if(k === 'sun') insectsApply(); }
    return;
  }
  const k = e.target.dataset.k; if(!k) return;
  SC[k] = +e.target.value; if(!SC.on) scEnable(true); sceneSave(); sceneApply();
});
$('#scenePanel').addEventListener('click', e => {
  const t = e.target;
  const reseed = () => { SC.on = true; sceneSave(); if(SC.kind === 'meadow') meadowRebuild(); else ssiLoad(); };
  if(t.id === 'scGo'){ SC.seed = $('#seed').value || SC.seed; reseed(); }
  else if(t.id === 'scDice'){ SC.seed = String(Math.floor(Math.random()*1e6)); const sd = $('#seed'); if(sd) sd.value = SC.seed; reseed(); }
  else if(t.id === 'scL' || t.id === 'scR'){ try{ ssi.contentWindow.xcroll(t.id === 'scL' ? -300 : 300); layersBuild(); }catch(err){} }
  else if(t.dataset.kind){ SC.kind = t.dataset.kind; SC.on = true; clearLayers(); if(SC.kind !== 'meadow') ssiLoad(); sceneSave(); scenePanel(); }
  else if(t.dataset.p){ Object.assign(SC, PRESETS[t.dataset.p]); scEnable(true); scenePanel(); }
  else if(t.id === 'scReset'){                          // this kind's sliders only; kind, seed and on/off stay
    if(SC.kind === 'meadow'){ SC.meadow = {...MEADOW_DEF}; SC.light = SC_DEF.light; meadowRebuild(); } else for(const [k] of SLIDERS) SC[k] = SC_DEF[k];
    sceneSave(); scenePanel();
  }
  else if(t.closest('#scClose')){ $('#scenePanel').hidden = true; $('#bScene').focus(); }
  sceneApply();
});
if(SC.on) ssiLoad();

// ---------- routing + keys ----------
function route(){ const id = decodeURIComponent(location.hash.slice(1)); if(id) open(id); else setView('lib'); }
addEventListener('hashchange', route);
addEventListener('keydown', e => {
  if(e.key==='/' && document.activeElement!==$('#q') && view==='lib'){ e.preventDefault(); $('#q').focus(); return; }
  const a = document.activeElement;
  if(e.key==='Escape' && lb.style.display==='block'){ lb.style.display='none'; return; }
  if(e.key==='Escape' && view==='viewer'){                    // close the topmost thing; with nothing open, leave the viewer
    const p = openPop(); if(p){ pop(p, false); $('#'+p).focus(); return; }
    if(!$('#scenePanel').hidden){ $('#scenePanel').hidden = true; sceneApply(); $('#bScene').focus(); return; }
    if(narrow.matches && !$('#viewer').classList.contains('noinsp')){ setInsp(false); return; }
    location.hash = ''; return;
  }
  if(a.matches('input:not([type=checkbox],[type=radio]),select,textarea') || (a.type==='radio' && e.key.startsWith('Arrow'))) return;
  if(lb.style.display==='block'){ if(e.key==='ArrowRight') lbShow(lbI+1); if(e.key==='ArrowLeft') lbShow(lbI-1); return; }
  if(e.metaKey || e.ctrlKey || e.altKey) return;
  if(e.key.toLowerCase()==='o'){ fileIn.click(); return; }
  if(view!=='viewer') return;
  if((e.key===' ' || e.key==='Enter') && a.closest('button,a,summary,label')) return;   // let a focused control handle its own activation
  const k = e.key.toLowerCase(), on3d = !$('#bReset').disabled;
  if(k==='r') $('#bReset').click(); else if(k==='w' && on3d) setMode(flags.wire ? 'shaded' : 'wire'); else if(k==='c' && on3d) setMode(flags.clay ? 'shaded' : 'clay');
  else if(k==='k') $('#oSkel').click(); else if(k==='e') $('#bScene').click(); else if(k==='g') $('#oGrid').click(); else if(k==='b') $('#oBox').click(); else if(k==='i') $('#bInsp').click();
  else if(k==='[') step(-1); else if(k===']') step(1);
  else if(k===' '){ e.preventDefault(); if(T.dur||T.audio) play(!T.playing); else $('#bRot').click(); }
  else if(e.key==='ArrowRight' && T.dur) setTime(T.t+5); else if(e.key==='ArrowLeft' && T.dur) setTime(T.t-5);
});

fetch('catalog.json').then(r => { if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then(d => Array.isArray(d?.items) ? d.items : [])
  .then(d => [d, null], e => [[], e])
  .then(([d, err]) => { lib = d; renderLib(); route(); if(err) showNotice(`Couldn't load catalog.json: ${err.message || err}`); thumbQueue(); });
