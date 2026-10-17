# Architecture

Open 3D Library is a static web app. There is no backend: the browser loads `catalog.json`, then loads model files from `assets/<id>/`. Everything runs locally. Three.js (0.186.1) is the only runtime dependency; Vite bundles the code.

## Files

| Path | Role |
|---|---|
| `index.html` | Page shell: library header, viewer header, stage, inspector, transport bar, age gate. Loads `src/app.js`. |
| `src/app.js` | The app. Library grid, search and filters, thumbnails, model loading, viewer, inspector, animation transport, scene backdrops. |
| `src/meadow.js` | Procedural 3D meadow (see below). |
| `src/fauna.js` | Wildlife behaviour. Loads animals from `vendor/procedural-animals`. |
| `src/insects.js` | Butterflies, dragonflies and fireflies. |
| `src/vmdplayer.js` | Builds a mannequin and plays a VMD motion on it. |
| `src/loaders/FBXLoaderNoMorph.js` | Copy of three's `FBXLoader` with morph-target parsing disabled. Used as a fallback. |
| `src/style.css` | Styles. |
| `vendor/` | Vendored code bundled by Vite: `procedural-animals/`, `mmdparser/`. |
| `public/vendor/` | Vendored pages loaded in an iframe: shan-shui-inf, nonflowers, fishdraw. |
| `serve.py` | Optional local server. |

`meadow.js`, `fauna.js`, `insects.js`, `vmdplayer.js` and the FBX fallback are loaded with dynamic `import()` so they are not part of the first load.

## app.js

Roughly in file order:

- **Model loading** (`fetchModel`). Picks a loader by extension: `GLTFLoader` for GLB/glTF, `FBXLoader` for FBX, `OBJLoader` (with `MTLLoader` when a matching `.mtl` exists) for OBJ. A `LoadingManager` URL modifier resolves texture requests to the item's own files by normalised name. If three's FBX loader throws a `TypeError`, the load is retried with `FBXLoaderNoMorph`. A failed download is retried up to twice.
- **Texture repair** (`fixTextures`). Applies per-item `textureOverrides`, then matches image files to materials by name and role (colour, normal, bump), then drops maps whose image never arrived so they do not render black.
- **Stage.** One `WebGLRenderer`, a perspective camera, `OrbitControls`, a room environment for reflections, a hemisphere light and a directional key light. `mount()` adds the model, computes its bounding box and span (largest dimension), and creates the grid, the shadow-casting sun, a shadow-catching ground and an ink-wash ground texture.
- **Viewer toolbar.** Three zones: navigation (back, previous/next, title), view (a Shaded / Clay / Wireframe radio group, reset, zoom, auto-rotate) and output (Overlays popover with grid, bounding box and bones; Scene; background; screenshot as PNG with a transparent background; open; inspector). Below 1024 px the right zone moves into a "More" popover. Controls are disabled with the reason as their tooltip when they do not apply (no rig, no 3D view).
- **Inspector.** Collapsible sections: the catalogue entry (description, author, licence, source link, tags), model stats (meshes, triangles, vertices, materials, textures, bones, animations, size in scene units), the clip list, a mesh list with visibility toggles, per-mesh details on pick, textures, unused image files and files. It is a side panel on desktop and a bottom sheet below 768 px.
- **Transport.** One timeline for the animation clip and an optional audio file; play, seek, speed, loop, clip select.
- **Library.** Cards from the catalogue (grid or list layout), search, type chips generated from the item types with counts, sorting by name, type or size, a licence badge derived from `license`, thumbnails. Missing thumbnails are rendered in the page with a small offscreen renderer and, when served by `serve.py`, POSTed back to be saved under `<assets>/.thumbs/`. Items flagged `sensitive` show blurred thumbnails and ask for confirmation on every open.
- **Routing.** The URL hash is the item id (`#animal-fox`).
- **Scene backdrops.** State is kept in an object saved to `localStorage`. Backdrop kinds: mountains (shan-shui-inf), flowers (nonflowers), fish (fishdraw) and Meadow (3D). The first three render in an iframe or as SVG layers behind the canvas, sorted into depth layers with parallax, haze and blur, plus a foreground layer drawn over the model. Meadow renders in the same three.js scene.
- **Meadow wiring** (`meadowApply`, `insectsApply`, `faunaApply`). The meadow exists only while Scene is on, the kind is Meadow and a model is mounted. Fauna and insects are created after the meadow and disposed with it.

## Meadow (`src/meadow.js`)

`createMeadow({scene, span, center, seed, params, wind})` returns an object with the scene `group`, `setParams()`, a per-frame update, `ground(x, z)` and `waterDepth(x, z)` height queries, and `dispose()`. Same seed gives the same meadow.

- **WindSystem.** Shared wind state (direction, strength, speed, gust). Vegetation, fauna and insects read it.
- **Terrain.** Seeded value noise with fbm for height and moisture. The ground is flattened under the model so its feet sit on it. A pond sits behind the model on a seeded side; its outline is irregular and the depth is baked into the terrain.
- **Vegetation.** Kinds: grass, flowers, docks, weeds (rosettes), fallen leaves, drifting leaves, and pond plants (lily pads, lotus, cattails, reeds). Each kind has a generated geometry and is drawn as chunked instanced meshes placed with a seeded Halton scatter, so any prefix of an instance buffer is an even subset. Level of detail is the instance count, set per chunk from its distance. An adaptive density guard thins grass when frames get slow.
- **Shared vegetation shader.** All kinds use one material builder (`vegMaterial`) on three's Lambert lighting, patched with `onBeforeCompile`. Shared GLSL provides noise, the wind (swell, sway, flutter, gusts), season and wetness tints, and moss. Each kind adds its own vertex body (grass blades, bending stems with organs, rosettes, leaves, pads). Because it uses three's lighting, vegetation receives the model's shadow-map shadow, the sun and fog.
- **Pond and water.** Translucent water using the baked depth, wind waves, rain ripples, rings and droplet splashes.
- **Sky and weather.** A gradient sky with sun and procedural clouds. The same cloud field casts moving shadows on the ground. Sliders drive weather (clear to rain with fog and wet ground) and season (spring, summer, autumn, winter).
- **Parameters.** `MEADOW_DEFAULTS` lists them: pond, grass height, density, wind, speed, gusts, direction, dryness, roughness, sun, flowers, weeds, leaves, falling leaves, clouds, weather, season.

## Fauna and insects

- `src/fauna.js` places animals in a group scaled so the model is 1.65 m tall, and gives each animal a small state machine with its own traits. Species and counts depend on a wildlife level: rabbit, crow, cat, a second crow, dog. Animals use the meadow's ground height and water depth, drink at the pond, perch on props and part the grass.
- `vendor/procedural-animals` (threejs-procedural-animals) builds the animals: sculpted meshes, rigs, fur and feather shaders, IK motion. Local changes are listed in `THIRD_PARTY_NOTICES.md`.
- `src/insects.js` draws butterflies, dragonflies and fireflies as three instanced meshes. Paths and flapping are computed on the GPU from a time uniform. Fireflies glow when the sun is low.

## VMD player (`src/vmdplayer.js`)

VMD files are parsed with `vendor/mmdparser`. The player builds a capsule mannequin with the standard MMD bone names, applies arm, spine and head keys with forward kinematics, and solves the legs from the foot-IK bones with a two-bone IK. The result is a normal `Object3D` with an animation clip, so it goes through the same transport as other models.

## Catalogue format

`catalog.json` is `{"items": [...]}`. Item fields:

| Field | Meaning |
|---|---|
| `id` | Folder name, `<type>-<name>`. Used in the URL hash and in file URLs. |
| `type` | Part of the folder name before the first `-`: `animal`, `character`, `material`, `nature`, `test`, `reference`, ... |
| `name` | Display name. Taken from `meta.json`, else from the folder name. |
| `files` | List of `{n, s}`: file name and size in bytes. Reference images may also have `t`, a small thumbnail path. |
| `description`, `license`, `author`, `source`, `tags` | From `meta.json`. |
| `textureOverrides` | Optional map of mesh name (or `*`) to an image file name or a `#rrggbb` colour. |
| `sensitive` | Optional. Set from `meta.json` or from the `adult.json` list. |
| `thumb` | Optional path to a generated preview under `assets/.thumbs/`. |

The catalogue comes from one of two places:

- `npm run catalog` runs `serve.py --write-catalog public/catalog.json`. The file is copied into the build and committed.
- `serve.py` generates it live from the asset folder (cached, rebuilt when the folder changes) and serves it at `/catalog.json`.

## Asset resolution

The app requests `catalog.json` and `assets/<id>/<file>` relative to the page. With `npm run dev` or `npm run preview`, these come from `public/`. With `serve.py`, `/assets/` maps to the folder given with `--assets` (default `public/assets`) and the app files come from `dist/`. The Vite `assetsDir` is `bundle`, so it does not collide with `/assets/`.

Texture URLs inside a model are rewritten to the item's own image files by normalised file name (lower case, no extension, letters and digits only), so a model that asks for `Material #18_Diffuse.png` finds `Material__18_Diffuse.jpeg`.

## serve.py

Standard library only. Serves `dist/` and the asset folder, builds the catalogue, and accepts `POST /thumb/<id>.jpg` for previews. It listens on `127.0.0.1` by default, checks the `Host` header, serves no dotfiles except `.thumbs/` images, resolves real paths so symlinks cannot leave the served folders, and caps uploads at 2 MB (JPEG only, custom header required). See [SECURITY.md](../SECURITY.md).

`--assets DIR` and `--local-assets DIR` can each be repeated. The catalogue is the items of every root in order (the first root wins on a duplicate id, with a warning). `/assets/<id>/...`, `/assets/.thumbs/<id>...` and thumbnail POSTs all resolve inside the one root that owns `<id>`. Items from `--local-assets` carry `"collection": "local"` (the app shows a Local badge), and `--write-catalog` never includes them, so `public/catalog.json` cannot list private items.

## Units and scale

The meadow currently scales to the loaded model's height: `span` is the model's largest dimension and terrain, grass and the pond are sized from it. Fauna uses a metre scale inside a group scaled by `span / 1.65`. The plan is to scale models to metres and make the meadow fixed-size in metres.

## Roadmap

These are plans, not features.

- **Procedural generator interface.** A generator declares parameters and runs a fixed pipeline: params, generate, validate, preview, export. Generation is seeded so the same params and seed give the same result. Export is GLB through `GLTFExporter`, with the params stored in the glTF `extras`, so a file can be regenerated or tweaked later.
- **Split `app.js`.** Move the library, viewer, inspector, transport and backdrops into separate modules with a small shared state.
- **Accessibility.** The UI has labels, roles, focus rings and Escape handling, and passes axe-core. Still open: focus trapping in the lightbox and restoring focus after it closes.
