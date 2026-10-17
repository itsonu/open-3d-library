---
name: procedural-world-craft
description: Audit and improve realism and performance in procedural Three.js/WebGL natural environments and reusable procedural asset generators. Use for terrain, grass, plants, flowers, water, sky/fog/weather, wildlife, procedural geometry, animation, materials, coordinate-space bugs, browser performance/benchmarking, visual-regression work, and asset licensing for example libraries. Prioritize believable structure and behavior over adding features.
---

# Procedural World Craft

## Mission

Make the existing natural scene feel believable, coherent, and alive while preserving its architecture and browser performance. Do not equate realism with object count, noise, polygon count, or constant movement.

Default priority order:

1. Correct shape, proportions, transforms, and coordinate spaces.
2. Camera composition and subject readability.
3. Ecological placement and believable density.
4. Species-specific geometry and materials.
5. Coherent movement and interactions.
6. Fine surface detail.
7. New features only after the current scene is convincing.

## The FIELD framework

Use FIELD for every visual-improvement task:

### F — Frame the problem

- Inspect the current implementation before editing. Find the scene entry point, generators, shaders, shared state, model loaders, UI controls, and tests.
- Identify the user's exact visible complaint. Reduce it to one primary defect or a tightly related pair.
- Establish a fixed camera/view, default control values, and deterministic seed. Capture a baseline screenshot and record current shader errors, draw calls, triangle count, and GPU frame time when available.
- Use real-world reference images for the relevant species/biome. Do not rely on memory alone for plant anatomy, bird proportions, water edges, or terrain forms.
- Do not assume a visually wrong result is an art-direction problem. Check transforms, units, normals, shader coordinate spaces, asset scale, and render order first.

### I — Influence fields, not uniform placement

Represent the environment with reusable fields rather than isolated random decisions. Reuse existing helpers if present.

Useful fields include:

- terrain height and surface normal/slope
- water level and water depth
- soil/wetness/moisture
- light/shade exposure
- wind direction and strength
- disturbance/foot traffic
- distance to the camera or focal subject

Give every species a suitability rule. For example, reeds prefer wet margins; lily pads require suitable shallow/deeper water zones; dry-ground flowers prefer appropriate soil and light; grass density falls off near exposed mud or unsuitable slopes. Use continuous transitions between zones where nature would transition gradually.

Conceptual placement rule:

`spawnWeight = speciesSuitability(fields) * patchField(position) * localVariation(seed, position)`

Then apply hard constraints: valid ground/water depth, slope limits, collision spacing, exclusion zones, and camera/readability limits. A weight is not permission to ignore geometry.

Prefer a few clustered colonies with gaps over uniform noise. Use a cluster process plus a minimum-spacing rule (for example, Poisson-disk sampling inside irregular patch masks). Vary patch size and density. Leave bare soil and quiet areas. Randomness must be spatially correlated where the real world is correlated.

### E — Evolve forms with layered, species-specific rules

Build each asset from a small grammar of meaningful parts. A flower is not a stick with a sprite; a reed is not oversized grass; a bird is not a mesh stretched until it fits.

For plants, model the relationship between parts:

- roots/base meet the ground or water surface correctly
- stems taper and curve within species-appropriate limits
- leaves attach at plausible points along stems/branches
- leaf count, scale, angle, age, and shape vary within biologically plausible ranges
- flowers/buds attach to tips or branches; flower stages differ in shape
- plant height and structure respond to species, age, habitat, and local conditions

Use a small bank of authored procedural variants and weighted distributions. Preserve asymmetry, but avoid unconstrained randomness. Do not give every instance the same radial leaves, identical flower, or identical silhouette.

For animals, preserve original asset proportions and validate the root/rig/mesh transform chain. Check local versus world coordinates, parent scale, normals, skeleton, and materials before changing geometry. A transform-space bug should be fixed in the correct shared layer, not hidden by per-species scale hacks.

#### Multi-scale natural variation

Use different scales for different jobs:

- **Macro:** terrain shape, moisture regions, vegetation colonies, large bare patches.
- **Meso:** hills, clumps, individual plant silhouettes, branch structure, shoreline irregularity.
- **Micro:** leaf edges, petals, bark, ground texture, small colour/roughness changes.

Perlin/Simplex noise and fractal Brownian motion (fBm) are tools for smooth, correlated variation. A typical fBm combines several noise samples with increasing frequency and decreasing amplitude. Keep the large shapes dominant; fine noise should not overwhelm the silhouette. Use domain warping sparingly and only when it improves the form.

Use deterministic seeded randomness. Prefer separate seed streams per subsystem so adding flowers does not unexpectedly rearrange rocks, animals, or terrain.

Do not confuse surface noise with anatomy. Noise cannot repair a bad plant or animal shape.

### L — Link life through shared environmental state

Use the existing shared environment/wind model. Do not create a separate random oscillator for every object.

- Wind provides a direction, strength, gust envelope, and spatially coherent wave/flow.
- Each species maps that wind to its own response: grass bends easily; reed stems bend more slowly; branches move less; small leaves flutter mainly during gusts; lily pads mostly bob; lotus flowers move subtly.
- Anchor bending at the root/base. Do not translate whole plants as if they float.
- Use delta time or absolute elapsed time so movement is frame-rate independent.
- Use damping and bounded amplitudes; avoid per-frame random jitter.
- Use a time-varying noise field only as a slow, coherent input to wind or surface motion. Do not deform every terrain vertex with arbitrary animated noise just because it is possible.
- Rain, wetness, water ripples, plants, and animal behavior should consume the same environment state where appropriate.
- Interactions must obey geometry and habitat: terrestrial animals stop at the water edge, fish stay in water, insects gather around fitting habitat, animals transition between behavior states and cannot remain stuck forever.

Simple behavior with correct timing and placement is better than many elaborate behaviors that look robotic.

### D — Demonstrate, inspect, and measure

Do not call a change successful because it compiles, a formula looks coherent, or one screenshot exists.

After each focused change:

1. Run the existing app using the repository's actual workflow.
2. Check browser console and shader compilation for errors/warnings.
3. Inspect a close view, normal camera view, and wide view. Keep camera, seed, and UI settings the same as the baseline for comparison.
4. Watch live motion for at least 30 seconds when animation is involved. A few screenshots do not prove motion looks natural. If the background tab throttles, bring the viewport to the foreground; do not misreport throttled FPS as full performance.
5. Check multiple deterministic seeds or placements when changing procedural variation. A single attractive seed may hide a broken generator.
6. Record active-tab frame time/FPS, draw calls, triangle count, and console status when available.
7. Check subject readability: the model/animal, shoreline, and major scene features must not be hidden by foreground plants.
8. Report what was actually observed. Label simulated/formula-only checks as such.

## Implementation rules for browser scenes

- Keep the current app architecture and public scene controls unless the user asks for architectural work.
- Prefer instancing, batched geometry, shared materials, texture atlases, chunking, and distance-based LOD for repeated objects.
- Use simpler silhouettes/impostors for distant details; reserve expensive geometry for elements that visibly benefit from it.
- Avoid CPU-updating large vertex buffers every frame when a shader or lower-frequency update is sufficient.
- Keep interactive objects separate when needed; merge static objects when it materially reduces draw calls.
- Bake static lighting only when it is compatible with dynamic weather, time-of-day, and moving objects. A baked result can be fast but may break when lighting is expected to change.
- Use GLB/glTF for browser assets where appropriate. Before export, verify applied transforms, scale/units, normals, origin/pivot, UVs, material channels, animation export, and asset license.
- Test the exact Three.js revision used by the viewer. A dependency's current branch may rely on newer shader/material APIs.
- Do not blindly port Infinigen's full Blender pipeline into the real-time renderer. Its high-detail geometry, path-traced output, and generation cost target a different workload. Borrow its asset-specific rules, distributions, structure, and scene-composition ideas; use Blender/offline generation for selected assets only when it provides a worthwhile quality/performance trade.

## Visual debugging heuristics

- **Plant wobble:** find all per-instance oscillators and random jitter. Replace them with the shared wind field and species-specific stiffness/amplitude. Keep most objects nearly still during calm weather.
- **Too much grass:** fix the spatial density field and foreground/camera mask; do not merely shrink every blade. Create openings and patchy coverage.
- **Flowers look like sticks:** add anatomically placed basal/alternate leaves, stem taper/curvature, and plausible flower attachment. Avoid identical leaf stars.
- **Reeds look like grass:** give reeds separate stem/leaf/seed-head morphology.
- **Lotus too tall:** derive stem/leaf/flower heights from water depth and species dimensions; do not scale all parts uniformly without checking attachment points.
- **Animal looks stretched:** inspect world/local transforms, inherited scale, skeleton and source dimensions before modifying the asset.
- **Eyes or materials disappear under group scaling:** inspect shader coordinate spaces and uniforms, not just mesh/material existence.
- **Water looks like a plate:** derive depth/shoreline from the actual terrain/water relationship, use smooth depth-dependent colour/transparency, and inspect both low and glancing view angles.
- **Everything looks too noisy:** reduce detail density. Increase silhouette clarity, empty space, material coherence, and larger-scale structure.

## Change protocol

1. **Audit first.** State the likely root cause and the evidence you need. Do not start by adding features.
2. **Make one focused change.** Avoid unrelated refactors and new ecosystem categories.
3. **Check regressions.** Recheck nearby scene systems affected by shared shaders, geometry, transforms, or version changes.
4. **Compare.** Use the same camera, seed, settings, and approximate lighting before/after.
5. **Commit only according to the user's existing workflow.** Never claim a commit unless a commit was actually created. Do not commit if the repository's rules require user-controlled batching.
6. **Report exact results.** Include root cause, fix, visual evidence checked, performance measurement method, files changed, remaining artificial-looking elements, and commit hash/status.

## Complementary references (load when relevant)

These files hold verified, reusable lessons from real passes on a three.js r186 meadow with procedural wildlife. Read the one that matches the task before acting:

- `references/verified-lessons.md`: recurring root causes and their correct fixes. Covers shader coordinate spaces under scaled parents, scene-anchored fog and the low-sun sky, vertex-bound fur shells and screen-size LOD, per-vertex low-frequency noise, flower and reed morphology rules, three.js `onBeforeCompile` pitfalls, and visual-inspection traps (stale frames, camera clamps, subjects out of frame).
- `references/benchmarking.md`: a measurement protocol that survives GPU clock drift and adaptive-quality systems. Covers fixed layouts at known screen fractions, frozen behaviour, the CPU-submit vs GPU-wait split, the resolution test for fill-bound vs vertex-bound, paired before/after runs, in-page A/B by swapping materials, and what to report.
- `references/generators-and-assets.md`: the reusable generator contract (parameters → generate → validate → preview → export, seeded streams, GLB export with parameters in `extras`), plus the asset-licensing rules for example libraries (verified source per asset, CC BY attribution, local-only collections kept out of version control).

When a pass touches more than one of these areas, prefer fixing the shared layer (a shader chunk, the environment state, the generator interface) over per-object compensation.

## Definition of done

A realism pass is done only when:

- the specific visible defect is fixed for the correct reason;
- shapes, attachments, proportions, transforms, and habitat constraints are plausible;
- variation looks natural across multiple seeds, not only one lucky result;
- motion is observed live and reads as coherent rather than twitchy or synchronized;
- the subject and scene composition remain readable;
- there are no new shader/console errors or regressions;
- performance is measured under a stated condition (resolution, pixel ratio, layout, GPU) with a paired before/after in the same session;
- an unreproduced defect is reported as unresolved, never as fixed by a nearby change;
- remaining limitations are reported honestly.

## Source principles

These sources inform the method; they are not instructions to copy their entire implementation:

- Andrew Woan, “Building a Fully-Featured 3D World in the Browser with Blender and Three.js” (Codrops, 2025): reference collection and blockout, applied scale/normals, PBR material variation, economical foliage using planes/sprites/instances, deleting invisible geometry, selective baking, GLB export, draw-call trade-offs, smooth interpolation, chunked loading, device-specific checks, and a useful postmortem on scale/composition mistakes. https://tympanus.net/codrops/2025/04/08/3d-world-in-the-browser-with-blender-and-three-js/
- Raistrick et al., “Infinite Photorealistic Worlds using Procedural Generation” (Infinigen, arXiv:2306.09310): asset-specific probabilistic generators; separate interpretable controls from internal variation; procedural geometry/materials; terrain, vegetation, creatures, water/weather; surface scattering; coherent placement/composition; camera-aware level of detail. The paper's Blender/path-tracing workload is not a browser performance target. https://arxiv.org/abs/2306.09310
- Robert Coxe, “Generating Natural Forms: A Guide to Mountain Terrain Animation with Perlin Noise in Javascript” (Silphium Design, 2025): coordinate scale, layered fBm for macro-to-micro detail, 3D-noise sampling for smooth temporal change, vertex displacement, normals, and the option to move heavy deformation into shaders. Animated noise must still be bounded and tied to plausible physical motion. https://silphiumdesign.com/natural-forms-mountain-animation-perlin-noise/

## Default task prompt

When the user asks for a realism improvement, begin with:

“Inspect the existing implementation and current rendered scene first. Identify the single most visible realism defect and its root cause. Preserve the current architecture and controls. Make one focused fix using FIELD. Use deterministic seeds and the same camera/settings for before/after comparison. Inspect the live scene, check console/shaders and regressions, measure browser performance, and report only verified results. Do not add features to compensate for bad shape, placement, materials, or animation.”
