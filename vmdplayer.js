// Plays an MMD motion (.vmd) on a built-in mannequin, so a VMD can be previewed without a .pmx/.pmd model.
// Bones follow the standard MMD names/hierarchy (left = +x, front = -z; the whole figure is mirrored on z so it faces the camera).
// Arms/spine/head are forward kinematics from the VMD; legs are solved from the VMD's foot-IK bones with a two-bone IK.
import * as THREE from 'three';

// name, parent, rest position (MMD units; ~16 tall). 'L'/'R' rows expand to 左/右 with x mirrored.
const CORE = [['全ての親', null, 0, 0, 0], ['センター', '全ての親', 0, 8.4, 0], ['グルーブ', 'センター', 0, 8.9, 0], ['腰', 'グルーブ', 0, 9.8, 0],
  ['上半身', '腰', 0, 10.0, 0], ['上半身2', '上半身', 0, 11.6, 0], ['首', '上半身2', 0, 13.4, 0], ['頭', '首', 0, 14.2, 0], ['頭先', '頭', 0, 16.2, 0], ['下半身', '腰', 0, 9.6, 0]];
const SIDE = [['肩', '上半身2', .6, 13.2, 0], ['腕', '肩', 1.8, 13.1, 0], ['ひじ', '腕', 4.26, 11.39, 0], ['手首', 'ひじ', 6.72, 9.68, 0], ['手先', '手首', 7.87, 8.88, 0],
  ['足', '下半身', .9, 9.0, 0], ['ひざ', '足', .9, 4.7, -.15], ['足首', 'ひざ', .9, 1.3, 0], ['つま先', '足首', .9, 0, -1.4], ['足ＩＫ', '全ての親', .9, 1.3, 0]];
// limb capsules: parent bone -> child bone, radius
const LIMBS = [['上半身', '上半身2', .95], ['上半身2', '首', 1.05], ['首', '頭', .35], ['下半身', null, .95], ['頭', '頭先', 1.0],
  ['肩', '腕', .4], ['腕', 'ひじ', .38], ['ひじ', '手首', .31], ['手首', '手先', .3], ['足', 'ひざ', .58], ['ひざ', '足首', .44], ['足首', 'つま先', .32]];
const VMD_ALIAS = {'左肩P': '左肩', '右肩P': '右肩'};            // shoulder-P tracks drive the shoulder
const IK_DRIVEN = /^(左|右)(足|ひざ|足首)$/;                       // legs come from the IK bones, not from FK keys

function bez(x1, y1, x2, y2, u){                                  // MMD easing curve: y at parameter x = u
  if(u <= 0) return 0; if(u >= 1) return 1;
  let lo = 0, hi = 1, t = u;
  for(let i = 0; i < 18; i++){ t = (lo + hi) / 2; const x = 3*(1-t)*(1-t)*t*x1 + 3*(1-t)*t*t*x2 + t*t*t; if(x < u) lo = t; else hi = t; }
  return 3*(1-t)*(1-t)*t*y1 + 3*(1-t)*t*t*y2 + t*t*t;
}

export async function buildMannequin(vmdBuffer){
  const mod = await import('three/addons/libs/mmdparser.module.js');
  const vmd = new (mod.MMDParser || mod).Parser().parseVmd(vmdBuffer, true);

  // ---- skeleton
  const rows = [...CORE];
  for(const [s, sx] of [['左', 1], ['右', -1]]) for(const [n, p, x, y, z] of SIDE)
    rows.push([s + n, (p === '上半身2' || p === '下半身' || p === '全ての親') ? p : s + p, sx * x, y, z]);
  const abs = {}, B = {}, inner = new THREE.Group(), outer = new THREE.Group();
  rows.forEach(([n, p, x, y, z]) => { abs[n] = new THREE.Vector3(x, y, z); });
  rows.forEach(([n, p], i) => {
    const b = n.endsWith('ＩＫ') ? new THREE.Object3D() : new THREE.Bone();
    b.name = 'b' + i; b.userData.mmd = n; B[n] = b;
    b.position.copy(abs[n]).sub(p ? abs[p] : new THREE.Vector3());
    (p ? B[p] : inner).add(b);
  });
  outer.add(inner); outer.scale.z = -1;                           // MMD is left-handed

  // ---- body (capsules parented to bones, so they deform with FK/IK for free)
  const matL = new THREE.MeshStandardMaterial({color: 0xd9c4bb, roughness: .65, side: THREE.DoubleSide});
  const matR = new THREE.MeshStandardMaterial({color: 0xbfc9d6, roughness: .65, side: THREE.DoubleSide});
  const matC = new THREE.MeshStandardMaterial({color: 0xcfd2d8, roughness: .65, side: THREE.DoubleSide});
  const addLimb = (bone, child, r, mat, name) => {
    let mesh;
    if(!child){ mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), mat); }
    else{
      const off = B[child].position.clone(), len = off.length();
      mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(len - 2*r, .01), 6, 14), mat);
      mesh.position.copy(off).multiplyScalar(.5); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), off.normalize());
    }
    mesh.name = name; bone.add(mesh);
  };
  for(const [p, c, r] of LIMBS){
    if(p === '上半身' || p === '上半身2' || p === '首' || p === '頭' || p === '下半身') addLimb(B[p], c && B[c] ? c : null, r, matC, p === '頭' ? 'head' : p);
    else for(const s of ['左', '右']) addLimb(B[s + p], B[s + c] ? s + c : null, r, s === '左' ? matL : matR, s + p);
  }
  const head = B['頭'].children.find(m => m.isMesh); head.geometry = new THREE.SphereGeometry(1.0, 24, 18); head.position.set(0, 1.0, 0); head.quaternion.identity();

  // ---- clip: sample every VMD track at 30 fps (with MMD's bezier easing) into ordinary keyframe tracks
  const byBone = {};
  for(const m of vmd.motions){ const n = VMD_ALIAS[m.boneName] || m.boneName; if(B[n] && !IK_DRIVEN.test(n) && !n.endsWith('ＩＫ')) (byBone[n] ??= []).push(m); }
  const last = Math.max(1, ...vmd.motions.map(m => m.frameNum)), tracks = [];
  const lerpN = (a, b, t) => a + (b - a) * t;
  for(const [n, keys] of Object.entries(byBone)){
    keys.sort((a, b) => a.frameNum - b.frameNum);
    const times = [], pos = [], rot = [], hasPos = keys.some(k => k.position.some(v => v !== 0)), q = new THREE.Quaternion(), q2 = new THREE.Quaternion();
    let i = 0;
    for(let f = 0; f <= last; f++){
      while(i < keys.length - 2 && keys[i + 1].frameNum <= f) i++;
      const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
      let t = b.frameNum === a.frameNum ? 1 : Math.min(1, Math.max(0, (f - a.frameNum) / (b.frameNum - a.frameNum)));
      if(f < a.frameNum) t = 0;
      const I = b.interpolation, ease = k => bez(I[k] / 127, I[k + 4] / 127, I[k + 8] / 127, I[k + 12] / 127, t);
      times.push(f / 30);
      if(hasPos) for(let j = 0; j < 3; j++) pos.push(abs[n].clone().sub(B[n].parent === inner ? new THREE.Vector3() : abs[B[n].parent.userData.mmd]).getComponent(j) + lerpN(a.position[j], b.position[j], ease(j)));
      q.fromArray(a.rotation); q2.fromArray(b.rotation); q.slerp(q2, ease(3)); rot.push(q.x, q.y, q.z, q.w);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${B[n].name}.quaternion`, times, rot));
    if(hasPos) tracks.push(new THREE.VectorKeyframeTrack(`${B[n].name}.position`, times, pos));
  }
  const clip = new THREE.AnimationClip('MMD motion', last / 30, tracks);
  outer.animations = [clip];

  // ---- leg IK, run after the mixer each frame
  const inv = new THREE.Matrix4(), M = new THREE.Matrix4(), V = new THREE.Vector3(), Q = new THREE.Quaternion();
  const posIn = b => { M.copy(inv).multiply(b.matrixWorld); return V.setFromMatrixPosition(M).clone(); };
  const quatIn = b => { const q = new THREE.Quaternion(), chain = []; for(let n = b; n && n !== inner; n = n.parent) chain.push(n); for(let i = chain.length - 1; i >= 0; i--) q.multiply(chain[i].quaternion); return q; };
  const legs = ['左', '右'].map(s => ({hip: B[s + '足'], knee: B[s + 'ひざ'], ank: B[s + '足首'], ik: B[s + '足ＩＫ']}));
  outer.userData.post = () => {
    outer.updateMatrixWorld(true); inv.copy(inner.matrixWorld).invert();
    for(const {hip, knee, ank, ik} of legs){
      const L1 = knee.position.length(), L2 = ank.position.length(), h0 = posIn(hip), tgt = posIn(ik), d = tgt.clone().sub(h0), D = d.length();
      if(D < 1e-6) continue;
      const dir = d.clone().divideScalar(D), Dc = Math.min(Math.max(D, Math.abs(L1 - L2) + 1e-3), L1 + L2 - 1e-3);
      const a = (L1*L1 - L2*L2 + Dc*Dc) / (2*Dc), h = Math.sqrt(Math.max(L1*L1 - a*a, 0));
      const bend = new THREE.Vector3(0, 0, -1); bend.addScaledVector(dir, -bend.dot(dir)); if(bend.lengthSq() < 1e-6) bend.set(0, 0, -1); bend.normalize();
      const kneeP = h0.clone().addScaledVector(dir, a).addScaledVector(bend, h), ankP = h0.clone().addScaledVector(dir, Dc);
      const pQ = quatIn(hip.parent);
      hip.quaternion.setFromUnitVectors(knee.position.clone().normalize(), kneeP.clone().sub(h0).normalize().applyQuaternion(pQ.clone().invert()));
      const hQ = pQ.clone().multiply(hip.quaternion);
      knee.quaternion.setFromUnitVectors(ank.position.clone().normalize(), ankP.clone().sub(kneeP).normalize().applyQuaternion(hQ.clone().invert()));
      const kQ = hQ.clone().multiply(knee.quaternion);
      ank.quaternion.copy(kQ.invert().multiply(quatIn(ik)));
    }
  };
  // IK bones animate like any other bone
  const ikTracks = [];
  for(const s of ['左', '右']){
    const n = s + '足ＩＫ', keys = vmd.motions.filter(m => m.boneName === n).sort((a, b) => a.frameNum - b.frameNum); if(!keys.length) continue;
    const times = [], pos = [], rot = [], q = new THREE.Quaternion(), q2 = new THREE.Quaternion(); let i = 0;
    for(let f = 0; f <= last; f++){
      while(i < keys.length - 2 && keys[i + 1].frameNum <= f) i++;
      const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
      const t = f < a.frameNum ? 0 : b.frameNum === a.frameNum ? 1 : Math.min(1, (f - a.frameNum) / (b.frameNum - a.frameNum)), I = b.interpolation, ease = k => bez(I[k] / 127, I[k + 4] / 127, I[k + 8] / 127, I[k + 12] / 127, t);
      times.push(f / 30);
      for(let j = 0; j < 3; j++) pos.push(B[n].position.getComponent(j) + lerpN(a.position[j], b.position[j], ease(j)));
      q.fromArray(a.rotation); q2.fromArray(b.rotation); q.slerp(q2, ease(3)); rot.push(q.x, q.y, q.z, q.w);
    }
    ikTracks.push(new THREE.VectorKeyframeTrack(`${B[n].name}.position`, times, pos), new THREE.QuaternionKeyframeTrack(`${B[n].name}.quaternion`, times, rot));
  }
  clip.tracks.push(...ikTracks); clip.resetDuration();
  outer.userData.info = `${Object.keys(byBone).length} FK tracks + 2 IK, ${last} frames`;
  return outer;
}
