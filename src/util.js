// Pure helpers shared by app.js and tests/unit.test.js (no DOM, no three.js).

// Escape data for use in HTML text and quoted attribute values.
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));

// A CSS url("...") token; quotes, backslashes and newlines in the value are escaped. Use esc() on top when it goes into an HTML attribute.
export const cssUrl = u => `url("${String(u).replace(/["\\\n\r\f]/g, c => '\\' + c.charCodeAt(0).toString(16) + ' ')}")`;

// ---------- library labels ----------
const TYPE_LABEL = {character:'Characters', animal:'Animals', material:'Materials', nature:'Nature', test:'Test files', outfit:'Outfits', pose:'Poses', reference:'Reference images', motion:'Motion', local:'Opened files'};
export const typeLabel = t => TYPE_LABEL[t] || String(t).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
// Short card badge for item.license: '' when there is none, 'Licence: see details' unless it is exactly one well-known licence.
export const licenseBadge = l => {
  const s = String(l ?? '').trim();
  return !s ? '' : /^cc0([- ]1\.0)?$/i.test(s) ? 'CC0' : /^cc[- ]by([- ]\d(\.\d)?)?$/i.test(s) ? 'CC BY' : /^public domain\b[^+;,]*$/i.test(s) ? 'Public domain' : 'Licence: see details';
};

export const ext = n => String(n).split('.').pop().toLowerCase();

// The file a dropped/selected set opens with: glb > gltf > fbx > obj > vmd (first in list order on ties).
export const MAIN = ['glb', 'gltf', 'fbx', 'obj', 'vmd'];
export const pickMain = files => files.filter(f => MAIN.includes(ext(f.n))).sort((a, b) => MAIN.indexOf(ext(a.n)) - MAIN.indexOf(ext(b.n)))[0];

// ---------- local files: URL -> blob resolution ----------
export const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const BLOB_ID = /^blob:.*\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;   // a real object URL (ours, or one a loader made for embedded data)
export const texBlocked = u => /\.(exr|tiff?|psd)$/i.test(String(u).split(/[?#]/)[0]);

// Map of lowercased relative path, every trailing sub-path and the basename -> url, for [{path, url}].
export function buildBlobs(files){
  const m = new Map();
  for(const {path, url} of files){
    const segs = path.replace(/\\/g, '/').split('/').filter(Boolean);
    m.set(segs.join('/').toLowerCase(), url);                                  // full path always wins
    for(let i = 1; i < segs.length; i++){ const k = segs.slice(i).join('/').toLowerCase(); if(!m.has(k)) m.set(k, url); }
  }
  return m;
}
// Resolve whatever a loader asked for to a blob URL of the dropped set; unmatched -> transparent 1x1 PNG, never the network.
export function resolveBlob(blobs, u){
  if(/^data:/i.test(u) || BLOB_ID.test(u)) return u;
  let p = u.split(/[?#]/)[0]; try{ p = decodeURIComponent(p); }catch(e){}
  const segs = p.replace(/\\/g, '/').split('/').filter(s => s && s !== '.' && s !== '..');
  for(let i = 0; i < segs.length; i++){ const hit = blobs.get(segs.slice(i).join('/').toLowerCase()); if(hit) return hit; }
  return BLANK_PNG;
}

// ---------- texture roles + material matching ----------
const IGNORE = new Set(['utility', 'raw', 's', 'rgb', 'srgb', 'texture', 'tex', 'map', 'image', 'img', 'open', 'gl', 'opengl', 'direct', 'x', 'dx', 'directx', 'linear', 'k']);
const ROLES = {
  map: ['albedo', 'diffuse', 'diff', 'color', 'colour', 'col', 'base', 'c'],
  normalMap: ['normal', 'normals', 'nrm', 'norm', 'nor', 'n'],
  bumpMap: ['bump', 'height'],
  roughnessMap: ['roughness', 'rough'],
  metalnessMap: ['metallic', 'metalness', 'metalic'],
  aoMap: ['ao', 'occlusion'],
  emissiveMap: ['emissive', 'emission'],
  alphaMap: ['opacity', 'alpha', 'transparency'],
};
const QUAL = new Set(['base', 'mixed', 'ambient']);
const ROLE_OF = Object.fromEntries(Object.entries(ROLES).flatMap(([p, ws]) => ws.map(w => [w, p])));
const tokens = n => (String(n).split(/[\\/]/).pop().replace(/\.[^.]+$/, '').match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) || []).map(t => t.toLowerCase());

// Strip 'mat'/'material'/'SG1'/'_low'/'_lod0' suffixes (never down to nothing), drop a Maya 'ns:' namespace, then keep only a-z0-9.
export function normName(n){
  let s = String(n).toLowerCase().split(':').pop();
  for(let t; (t = s.replace(/(?:sg\d*|mat|material)$|[_\-. ](?:low|lowpoly|lod\d*)$/, '').replace(/[_\-. ]+$/, '')) !== s && t; ) s = t;
  return s.replace(/[^a-z0-9]/g, '');
}
// 'cloth_Base_color_Utility_-_sRGB_-_Texture.png' -> {prop:'map', key:'cloth', lead:'cloth'}; null when no role word ends the name.
// The role is the last meaningful token ('leather_metal_Metallic_..' is metalness, 'leather_metal.png' has no role); key = the name before it.
export function texRole(file){
  const t = tokens(file);
  let i = t.length - 1; while(i >= 0 && (IGNORE.has(t[i]) || /^\d+$/.test(t[i]))) i--;
  const prop = ROLE_OF[t[i]];
  if(!prop) return null;
  while(i > 0 && QUAL.has(t[i - 1])) i--;                                      // 'Base_color', 'Mixed_AO'
  return {prop, key: normName(t.slice(0, i).join('_')), lead: String(file).toLowerCase().replace(/[^a-z].*$/, '')};
}

const lcp = (a, b) => { let i = 0; while(i < a.length && a[i] === b[i]) i++; return a.slice(0, i); };
const score = (set, m) => {
  let best = m.lead && m.lead === set.lead ? 2 : 0;                              // legacy rule: 'bodi_skin' ~ 'bodi_Diffuse.png'
  for(const c of m.cands) best = Math.max(best, c === set.key ? 3 : c.replace(/\d+$/, '') === set.key || set.key.replace(/\d+$/, '') === c ? 2 : 0);
  return best;
};
// Which image goes on which material. names: image file names; mats: [{name, meshes:[mesh names]}] -> per material {prop: imageName} | null.
// 1) an image set (everything before the role word, e.g. 'cloth' or 'leather_metal') matches a material whose normalised name, or whose
//    meshes' names (with the prefix shared by all meshes removed), equal it; 2) a lone material takes the folder's set; 3) otherwise, when
//    exactly as many sets as materials are still unmatched, they are paired in name order (a guess: names carry no better hint).
export function planTextures(names, mats, single){
  const imgs = names.map(n => ({n, ...texRole(n)})).filter(i => i.prop);
  const sets = new Map();
  for(const i of imgs) if(i.key){ const s = sets.get(i.key) ?? sets.set(i.key, {key: i.key, lead: i.lead, files: {}}).get(i.key); s.files[i.prop] ??= i.n; }
  const all = [...new Set(mats.flatMap(m => m.meshes.map(x => x.toLowerCase())))], pre = all.length > 1 ? all.reduce(lcp) : '';
  const ms = mats.map(m => ({
    lead: String(m.name).toLowerCase().replace(/[^a-z].*$/, ''),
    cands: [m.name, ...m.meshes.flatMap(x => [x, pre && x.toLowerCase().startsWith(pre) && x.length > pre.length ? x.slice(pre.length) : null])].filter(Boolean).map(normName).filter(Boolean),
  }));
  const plan = mats.map(() => null), used = new Set();
  ms.forEach((m, i) => { let best = null, bs = 1; for(const s of sets.values()){ const v = score(s, m); if(v > bs){ best = s; bs = v; } } if(best){ plan[i] = best.files; used.add(best); } });
  if(single && plan[0] === null && names.length){
    const base = (imgs.find(i => i.prop === 'map') || imgs[0])?.key, files = {};
    for(const i of imgs) if(i.key === base || !i.key) files[i.prop] ??= i.n;
    if(!files.map && names.length === 1) files.map = names[0];            // legacy: a lone image is the colour map
    plan[0] = files;
  }
  const freeSets = [...sets.values()].filter(s => !used.has(s)).sort((a, b) => a.key < b.key ? -1 : 1);
  const freeMats = mats.map((m, i) => i).filter(i => !plan[i]).sort((a, b) => normName(mats[a].name).localeCompare(normName(mats[b].name), 'en', {numeric: true}));
  if(!single && freeSets.length && freeSets.length === freeMats.length) freeMats.forEach((i, k) => plan[i] = freeSets[k].files);
  return plan;
}
