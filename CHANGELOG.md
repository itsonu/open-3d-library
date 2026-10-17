# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - unreleased

First public version.

### Added

- Asset library: a catalogue of models with licence, author and source for each asset, generated thumbnails, search and type filters. Items can be marked as sensitive and ask for an age confirmation before opening.
- Viewer for GLB/glTF, FBX and OBJ+MTL files: orbit controls, framing, wireframe, clay material, grid, bounding box, skeleton display, auto-rotate and PNG screenshot.
- Inspector with meshes, materials and textures, mesh picking, and an animation transport (play, seek, speed, loop, clip list).
- Texture repair for exports that lost their texture links: explicit per-model rules, matching by material name, and dropping maps that never loaded.
- VMD motion playback on a built-in mannequin, with optional audio.
- Local file open and drag-and-drop.
- 2D reference image galleries with a lightbox.
- Scene backdrops: painted 2D backdrops (mountains, flowers, fish) from vendored LingDong- projects, with depth layers and parallax.
- Procedural 3D meadow backdrop: seeded terrain, instanced grass, flowers and plants, a pond, sky and clouds, weather and seasons, real shadows from the model, and an adaptive density guard for slow frames.
- Procedural wildlife (rabbit, crow, cat, dog) built on the vendored threejs-procedural-animals, and insects (butterflies, dragonflies, fireflies).
- Vite build (`npm run dev`, `build`, `preview`) with three.js 0.186.1 as the only runtime dependency.
- Optional hardened local server, `serve.py`: serves `dist/` and a private asset folder, generates `catalog.json`, and saves thumbnails.
- `npm run catalog` to regenerate `public/catalog.json` from `public/assets/<type>-<name>/meta.json`.
- Nine example assets under CC0, CC BY 4.0 or public-domain terms, listed in `ASSETS.md`.
- MIT licence, third-party notices, and tests for `serve.py`.
- Contributing guide, code of conduct, security policy, issue and pull request templates, and docs for the architecture, file formats and performance.
- A private local collection: `serve.py --local-assets DIR` (`npm run start:local`) shows assets you must not publish, with a Local badge. They are never written into the public catalogue. `npm run check:private` fails if anything from `local-assets/` is ever tracked.
- Browser smoke tests (Playwright, `npm run test:e2e`), CI on GitHub Actions, and a GitHub Pages deploy workflow.
- README with screenshots, and `npm run screenshots` to regenerate them.
- The `procedural-world-craft` Claude Code skill (`.claude/skills/`): the method, verified lessons and benchmarking protocol used to build the meadow.

### Changed

- The interface was redesigned and renamed Open 3D Library: design tokens, one button style with focus rings and pressed states, a three-zone viewer toolbar with a Shaded / Clay / Wireframe switch and an Overlays menu, type chips generated from the catalogue, grid and list layouts, sorting, licence badges, a sectioned inspector that shows catalogue metadata (a bottom sheet on phones), grouped scene sliders with "Reset to defaults", and ARIA labels and roles throughout.
- The catalogue is read from `catalog.json`; asset files live under `assets/<id>/`. Sensitive flags and texture overrides come from the catalogue items.
- Sources moved to `src/`; pages that run in iframes moved to `public/vendor/`.
- `serve.py` was rewritten as an optional server.
- FBX files with broken blend-shape data now load through a local loader that skips morph targets.
- Texture repair matches Substance-style image sets (`_Base_color`, `_Normal_OpenGL`, `_Roughness`, `_Metallic`, `_Mixed_AO`) to materials by material and mesh name.
- Models are framed to the narrower field of view, so they are no longer cropped on portrait screens.
- Phong materials exported with a white specular and zero shininess no longer wash out to white.
- Animal fur and feather layers scale with the animal's size on screen and are skipped off screen (about 8 ms faster with five animals at 1280×720 on the reference machine; see `docs/performance.md`). Fog is anchored to the scene, so nearby animals and ground stay clear.

### Removed

- PMX and PMD model support. VMD motion files still play, on the built-in mannequin.
- Runtime loading of code from CDNs. All code is now bundled or vendored with its licence.

### Security

- `serve.py` listens on loopback only by default, checks the `Host` header, never serves dotfiles (except generated thumbnails), resolves real paths so symlinks cannot escape the served folders, and caps thumbnail uploads at 2 MB and JPEG only.
- Thumbnail uploads require a custom request header, so cross-site form posts are rejected.
- All catalogue, model and file names are HTML-escaped wherever they appear, and generated markup has no inline event handlers. Models opened from disk cannot make network requests for textures: unmatched texture URLs resolve to a blank image.
