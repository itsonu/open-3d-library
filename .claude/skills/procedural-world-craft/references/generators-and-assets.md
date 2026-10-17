# Reusable generators and example assets

## Generator contract

A generator turns parameters and a seed into a three.js object. It does not touch the scene, the UI or global state, so it can be previewed, validated, exported, tested and run in a worker.

```js
export default {
  id: 'flower-patch', version: 1, label: 'Flower patch',
  params: {                                   // drives the UI, defaults and validation
    seed:    {type: 'int', default: 1},
    count:   {type: 'int', min: 1, max: 500, default: 60},
    radius:  {type: 'number', min: .5, max: 20, default: 3, unit: 'm'},
    species: {type: 'enum', options: ['daisy', 'buttercup', 'poppy'], default: 'daisy'},
  },
  generate(p, {rng, signal}) {                // pure: params + seeded RNG -> THREE.Object3D
    const group = new THREE.Group(); /* ... */ return group;
  },
  validate(obj) {                             // issues: [{level:'error'|'warn', message}]
    return checkGeometry(obj, {maxTriangles: 2e5, requireNormals: true, finite: true});
  },
};
```

Rules:
- **Units are metres, Y up.** Do not scale generators to whatever model happens to be loaded. Take an explicit scale or position from the caller.
- **Use separate seed streams per subsystem**, e.g. `rng = stream(seed, 'flowers')`, so adding or changing one generator never rearranges another.
- **Keep variation controlled.** A seed change should produce a believable sibling, not a different scene.
- **Validate before preview or export:** finite positions, normals present, sensible bounds and triangle budget, materials assigned, no zero-area or degenerate instances (except intentionally hidden slots).
- **Export** with three's `GLTFExporter` to GLB, and store `{generator: id, version, params, seed}` in `extras`, so any exported asset can be regenerated.
- **Determinism test:** the same params and seed must give a byte-identical GLB (or identical geometry hashes) across runs.
- **Long-running generators** go in a worker, posting typed arrays back, with progress events and an `AbortSignal`. Real-time instanced vegetation that updates every frame stays on the main thread.
- **A scene is a composition of generators** (terrain, grass, flowers, rocks, pond), not one giant function. Shared state such as wind, weather, water level and moisture is passed in, never re-created per generator.

## Example assets and licensing

- **Every redistributed asset needs a verified source page and licence** recorded next to it (`meta.json`: name, description, license, author, source, tags) and in a human-readable `ASSETS.md`. Check the licence on the source page itself. Per-asset licences in sample-asset repositories vary.
- **Good sources (verify each asset anyway):**
  - Khronos glTF-Sample-Assets, where each model README has a "Legal" section and licences range from CC0 to CC BY to trademark-limited.
  - Poly Haven (CC0).
  - Author-dedicated public-domain research meshes.
  - Exclude NC/ND licences, trademark-restricted models, compressed variants that need decoders you do not ship, and sites whose licence pages contradict the pack pages.
- **CC BY assets:** keep the exact credit lines (all contributors: model, rig, conversion) in `ASSETS.md` and in the app's asset details.
- **"Free to download" is not a licence.** Franchise characters, real-person likenesses, adult content and store-licensed assets never go into a public example library.
- **Private or personal collections** belong in a separate, git-ignored asset root served only locally (e.g. a `--local-assets DIR` flag), excluded from any generated public catalogue. Back this with a pre-push check that fails if such paths are ever tracked.
- **Rewriting history before publishing:** if tracked files or commit messages ever named private assets, rewrite or squash before the first push, and switch author emails to the forge's noreply address if the owner wants that.
