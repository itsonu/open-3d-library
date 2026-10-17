# The synthesis — caveman version

**Blender + Three.js:** Make the view look right. Good shapes, materials, light, camera. Hide/remove what the viewer never sees. Keep the browser fast.

**Infinigen paper:** Every kind of thing needs its own rules. Tree rules differ from flower rules. Rock rules differ from bird rules. Use controlled variation, not one random button for everything.

**Perlin noise guide:** Big shape first. Medium shape next. Tiny details last. Nearby things should vary smoothly, not jump all over. Motion should flow, not twitch.

## The rule

Don't add more grass, flowers, or animals just to make the world feel alive. Give each thing rules for **how it forms, where it belongs, and how it moves**. Use the same environment forces, then watch the real scene and fix what looks fake.

## FIELD framework

- **F — Frame:** fix the camera, reference, seed, and visible problem.
- **I — Influence fields:** terrain, slope, light, wetness, water depth, and wind decide what can live where.
- **E — Evolve forms:** species-specific shapes + layered, seeded variation.
- **L — Link life:** one shared wind/weather/time model; each species responds differently.
- **D — Demonstrate:** watch it live, compare screenshots, check errors, measure FPS.

## What practice added

- **Check the space before the shape:** a "stretched" or "flat" animal is often a shader mixing world and local space under a scaled parent.
- **Haze belongs to the scene, not the lens:** keep the subject clear, hide the world's edge, and let only the distance fade.
- **Measure what costs:** fur shells cost geometry, not pixels, so scale them by screen size and drop them offscreen.
- **Compare like with like:** same frame size, layout and session, before and after.
- **Only ship assets you can prove you may share,** and keep personal collections local.
