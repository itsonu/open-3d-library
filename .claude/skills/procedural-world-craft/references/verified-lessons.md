# Verified lessons

Each entry is a root cause found and fixed on a real three.js r186 scene: a meadow with terrain, instanced vegetation, a pond, weather, and procedural animals parented under a scaled group. Each entry says how the bug looked, why it happened, the fix that worked, and how it was checked. Use them as hypotheses to test, not as facts about a new codebase.

## Coordinate spaces under scaled or moved parents

**Looks like:** eyes render flat or wrong when an animal is placed in the world. Fur reads hard and plastic. Feather fringes, seams or fins look thin or missing. Everything was fine in the library's own demo.

**Cause:** shader code mixed spaces.
- An eye shader compared a world-space position against an animal-local socket matrix.
- A coat shader transformed the skinned position to world space with `modelMatrix`, then added hair length, fin width, seam sink and depth bias in **metres of the animal's own space**. Under a ×60 parent these offsets shrank to 1/60.

**Fix (in the shared shader, not per species):**
- Eyes: pass `uLocalInv = inverse(parent.matrixWorld)` and compute `(uLocalInv * modelMatrix * vec4(position, 1)).xyz`.
- Coat: `float ws = length(modelMatrix[0].xyz);` and multiply every metre-sized world-space offset by `ws`. This is the identity at scale 1, so it is safe for unscaled users.

**Check:**
- Render the same frozen pose at parent scale 1 and at scale N, from the same relative camera.
- Silhouette IoU should be about 1.0. The coat and feather appearance should match between the two scales.
- A difference that appears only at scale N is a space bug.

**Not the cause of a "stretched animal":** if bone lengths match the bind pose in every action, the bone matrices have no scale, and the silhouette IoU at different scales is ≥ 0.999, the rig and transforms are fine. Report the defect as unresolved until you can reproduce it. Do not ship a nearby fix as the cure.

## Haze, fog and sky in small worlds

**Looks like:** animals a few metres away look ghosted, the ground looks blurry, and dusk turns the whole frame one orange. Wide shots look milky even next to the camera.

**Cause:** linear fog at fixed camera distances (about 2.6–11.5 m) was hiding the terrain edge of a small world. Pulling the camera back fogged the subject. At low sun the fog colour was the saturated sun-side horizon.

**Fix:**
- Anchor fog to the scene each frame, with `c` = distance from the camera to the scene centre:
  - `near = clamp(c + 1.5·span, …)`
  - `far = max(8·span, edge − c)`, where `edge` is the terrain's half-size
  - Scale both by `(1 − 0.6·rain)`.
- Grow the terrain so its edge always sits inside full fog, instead of thickening the fog.
- Low sun: blend the horizon colour by azimuth to the sun (warm only on the sun side, cool and pale elsewhere).
- Make the fog colour the average horizon, not the sun-side glow.
- Blend the sky's lowest band into the fog colour so the fogged ground meets the sky without a seam.
- Give water shaders the same fog colour uniform.
- Extend vegetation outward with a feathered density rim so the clearer air does not expose where grass stops.

**Check:** close, normal and wide views at clear, dusk-facing-the-sun, dusk-away and rain settings. The subject should stay crisp, and only the distance should haze.

## Performance: find what actually costs

- **Fur shells.** Shells are geometry instances: the skinned mesh is drawn once per layer, and dual-quaternion skinning runs per instance. Cost tracks *shell count × vertices*, not screen area.
  - **Test:** an offscreen animal still cost about 3.6 ms, and a near animal's cost barely changed at a quarter of the resolution.
  - **Fix:** choose the shell count from the animal's share of screen height (e.g. 16/10/7/5/3/0 at ≥60/30/12/5/2.2% / offscreen), with hysteresis and eased transitions.
  - Use the library's half-rate pose LOD only for tiny animals.
  - Visually, 10 shells matched 16 even at 60% of screen height. 6 shells showed a dark fringe up close.
- **Distance-fading fine terrain noise did not help** (no measurable change), so it was reverted. Always measure before keeping an "obvious" optimisation.
- **Low-frequency per-pixel noise.** Cloud shadows about 28 spans wide were computed per pixel. Moved into a vertex varying, they saved about 0.4 ms with a terrain-only render difference of 0.008/255.
- **Adaptive-quality guards** that thin grass when frames are slow change the scene between runs. Pin or account for them when comparing.

## Plants

- **Flowers looked like sticks.** Build leaf slots into the shared flower geometry: 5 slots with lanceolate and broad shapes, lower ones long and flat, upper ones short and upright. Let the vertex shader keep a seeded 1–5 per instance (buds 1–3, smaller and more upright) and vary size, height on stem, angle and tint. Hide unused slots by scaling them to zero.
- **Closed buds showed the flower centre below the petals.** Scale the centre with openness, e.g. `smoothstep(.15, .6, open)`.
- **Reeds read as tall grass.** Give them their own morphology: round culm from crossed ribbons, narrow arching blades, a slim drooping tan plume, and no petals.
- **Placement.** Cluster species into colonies from noise fields and the real water depth, with spacing claims so colonies don't overlap.

## three.js r186 specifics

- Materials customised with `onBeforeCompile` that share source **must** have unique `customProgramCacheKey()`s. Otherwise one program is reused for all of them.
- Custom instanced geometry needs a `normal` attribute, or newer three switches to flat shading and some Lambert chunks fail.
- Wrapping `MeshLambertMaterial` with a custom vertex body keeps three's shadows and fog for vegetation.
- `Fog` colours set with `SRGBColorSpace` are converted to linear. A raw `ShaderMaterial` sky that writes colours directly is not converted, so pick one convention per pipeline.
- Do not fetch and string-patch library loaders from a CDN at runtime. Commit a clearly marked modified copy pinned to the exact three version instead.

## Inspection traps

- In a throttled or hidden browser pane, screenshots can show a **stale frame**. Force renders, or wait several seconds and re-screenshot before judging.
- `OrbitControls.minDistance`/`maxDistance` silently pull a scripted camera away from where you put it.
- Animals wander, perch, or stand in water; birds may be perched 1+ m above the point you aim at. Project the subject to screen space (or aim at a bone, such as the pelvis) to confirm it is in frame before screenshotting.
- Saved UI settings (for example a dusk sun or a high season stored in `localStorage`) change what a user sees compared with the defaults. Reproduce the user's state first, then test defaults.
