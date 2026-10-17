import test from 'node:test';
import assert from 'node:assert/strict';
import {esc, cssUrl, pickMain, buildBlobs, resolveBlob, texBlocked, typeLabel, licenseBadge, texRole, normName, planTextures, BLANK_PNG} from '../src/util.js';

test('esc escapes & < > " \'', () => {
  assert.equal(esc(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  assert.equal(esc(undefined), ''); assert.equal(esc(5), '5');
});
test('cssUrl escapes quotes and backslashes', () => {
  assert.equal(cssUrl('a"b\\c\nd'), 'url("a\\22 b\\5c c\\a d")');
});

test('pickMain: glb > gltf > fbx > obj > vmd', () => {
  const f = (...n) => n.map(x => ({n: x}));
  assert.equal(pickMain(f('a.vmd', 'b.obj', 'c.fbx', 'd.gltf', 'e.glb')).n, 'e.glb');
  assert.equal(pickMain(f('a.vmd', 'b.obj', 'c.FBX')).n, 'c.FBX');
  assert.equal(pickMain(f('a.vmd', 'x.png', 'y.wav')).n, 'a.vmd');
  assert.equal(pickMain(f('a.png', 'b.txt')), undefined);
});

test('resolveBlob maps loader requests to blobs, anything else to a blank PNG', () => {
  const b = buildBlobs([{path: 'Pack/model.fbx', url: 'blob:m'}, {path: 'Pack/Textures/A.JPG', url: 'blob:a'}, {path: 'b.png', url: 'blob:b'}]);
  assert.equal(resolveBlob(b, 'textures/a.jpg'), 'blob:a');                  // relative path, any case
  assert.equal(resolveBlob(b, '../x/Textures/a.jpg'), 'blob:a');
  assert.equal(resolveBlob(b, 'C:\\foo\\bar\\a.jpg'), 'blob:a');             // windows path -> basename
  assert.equal(resolveBlob(b, 'blob:http://localhost:5173/B.PNG'), 'blob:b'); // loader resolved against the blob URL of the model
  assert.equal(resolveBlob(b, 'Pack/Textures/a%20.jpg'), BLANK_PNG);
  assert.equal(resolveBlob(b, 'my%20file.png'), BLANK_PNG);
  assert.equal(resolveBlob(b, 'https://evil.example/x.png'), BLANK_PNG);
  assert.equal(resolveBlob(b, 'data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  const own = 'blob:http://localhost:5173/3f2b8c1e-0a4d-4e0b-9a55-6d0a1c2b3d4e';
  assert.equal(resolveBlob(b, own), own);                                      // already-mapped / loader-made blob
});
test('texBlocked: exr/tif/tiff/psd', () => {
  for(const u of ['a.EXR', 'x/b.tif?v=1', 'c.tiff', 'd.psd']) assert.ok(texBlocked(u), u);
  for(const u of ['a.png', 'exr.png']) assert.ok(!texBlocked(u), u);
});

test('texRole: Substance-style names', () => {
  const r = n => { const x = texRole(n); return x && [x.prop, x.key]; };
  assert.deepEqual(r('cloth_Base_color_Utility_-_sRGB_-_Texture.png'), ['map', 'cloth']);
  assert.deepEqual(r('leather_metal_Metallic_Utility_-_Raw.png'), ['metalnessMap', 'leathermetal']);
  assert.deepEqual(r('leather_metal_Mixed_AO_Utility_-_Raw.png'), ['aoMap', 'leathermetal']);
  assert.deepEqual(r('silk_Normal_OpenGL_Utility_-_Raw.png'), ['normalMap', 'silk']);
  assert.deepEqual(r('silk_Roughness_Utility_-_Raw.png'), ['roughnessMap', 'silk']);
  assert.deepEqual(r('Body_BaseColor.png'), ['map', 'body']);
  assert.deepEqual(r('Body_Albedo.jpg'), ['map', 'body']);
  assert.deepEqual(r('body_Diffuse.png'), ['map', 'body']);
  assert.deepEqual(r('body_Height.png'), ['bumpMap', 'body']);
  assert.deepEqual(r('body_Emissive.png'), ['emissiveMap', 'body']);
  assert.deepEqual(r('body_Opacity.png'), ['alphaMap', 'body']);
  assert.deepEqual(r('body_Metalness.png'), ['metalnessMap', 'body']);
  assert.deepEqual(r('Material #18_Diffuse.jpeg'), ['map', 'material18']);
  assert.deepEqual(r('Normal.png'), ['normalMap', '']);
  assert.equal(r('leather_metal.png'), null);                                  // 'metal' is part of the name, not a role
  assert.equal(r('thumbnail.png'), null);
});
test('normName strips mat/material/SG/_low suffixes and namespaces', () => {
  assert.equal(normName('FemaleNobleKnight:shouldercloth_lowSG1'), 'shouldercloth');
  assert.equal(normName('Wood_Mat'), 'wood'); assert.equal(normName('Cloth Material'), 'cloth');
  assert.equal(normName('Material'), 'material'); assert.equal(normName('Body.001'), 'body001');
});

test('planTextures: sets match material/mesh names, leftovers pair in name order', () => {
  const names = ['cloth_Base_color_Utility_-_sRGB_-_Texture.png', 'cloth_Normal_OpenGL_Utility_-_Raw.png', 'leather_metal_Base_color_Utility_-_sRGB_-_.png', 'leather_metal_Metallic_Utility_-_Raw.png',
    'silk_Base_color_Utility_-_sRGB_-_Texture.png', 'silk_Roughness_Utility_-_Raw.png'];
  const G = 'FemaleNobleKnightgroup1', m = (name, ...ms) => ({name: 'FemaleNobleKnight:' + name, meshes: ms.map(x => G + x)});
  const plan = planTextures(names, [m('lambert8SG1', 'plate_belt_low', 'armcloth_low'), m('lambert9SG1', 'skirt_low', 'neckcloth_low'), m('shouldercloth_lowSG1', 'cloth_low', 'skirtcloth_low')], false);
  assert.equal(plan[2].map, names[0]);                                          // by mesh name 'cloth_low'
  assert.equal(plan[0].metalnessMap, names[3]);                                 // leftover pairing: lambert8 <- leather_metal
  assert.equal(plan[1].roughnessMap, names[5]);                                 // lambert9 <- silk
  // by material name, with suffixes and numbering
  assert.equal(planTextures(['Bodi_Diffuse.png', 'bodi_Normal.png', 'hair_Diffuse.png'], [{name: 'bodi_mat', meshes: []}, {name: 'hair.001', meshes: []}], false)[1].map, 'hair_Diffuse.png');
  // a lone material takes the folder's colour + normal, including a key-less normal.png
  assert.deepEqual(planTextures(['skin_Diffuse.png', 'normal.png'], [{name: 'Material.12', meshes: ['m']}], true), [{map: 'skin_Diffuse.png', normalMap: 'normal.png'}]);
  assert.deepEqual(planTextures(['onlyone.png'], [{name: 'x', meshes: []}], true), [{map: 'onlyone.png'}]);
  // nothing to go on with unequal counts: no guessing
  assert.deepEqual(planTextures(names, [{name: 'a', meshes: []}, {name: 'b', meshes: []}], false), [null, null]);
});

test('typeLabel: known labels, title-cased fallback', () => {
  assert.equal(typeLabel('test'), 'Test files'); assert.equal(typeLabel('reference'), 'Reference images');
  assert.equal(typeLabel('hard-surface_prop'), 'Hard Surface Prop');
});
test('licenseBadge: CC0, CC BY, public domain, otherwise see details, nothing without a licence', () => {
  assert.equal(licenseBadge('CC0-1.0'), 'CC0'); assert.equal(licenseBadge('CC-BY-4.0'), 'CC BY');
  assert.equal(licenseBadge('Public domain (author dedication)'), 'Public domain');
  assert.equal(licenseBadge('CC0-1.0 (model) + CC-BY-4.0 (rig)'), 'Licence: see details'); assert.equal(licenseBadge('CC-BY-SA-4.0'), 'Licence: see details');
  assert.equal(licenseBadge(''), ''); assert.equal(licenseBadge(undefined), '');
});
