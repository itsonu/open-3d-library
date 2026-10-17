# Contributing to Open 3D Library

Thanks for helping. This guide covers setup, layout, style, tests, the asset policy and how to send a change. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems as described in [SECURITY.md](SECURITY.md), not in public issues.

## Setup

You need Node 20 or newer. Python 3.9+ is optional (only for `serve.py` and the Python tests).

```sh
git clone https://github.com/itsonu/open-3d-library.git
cd open-3d-library
npm ci
npm run dev        # Vite dev server with hot reload
```

Other commands:

```sh
npm run build      # production build into dist/
npm run preview    # serve the production build
npm run catalog    # regenerate public/catalog.json from public/assets/*/meta.json
python3 serve.py   # optional: serve dist/ plus an asset folder (see below)
```

`serve.py` serves the built app (`dist/`) and a private asset folder, and generates `catalog.json` from that folder. Run `npm run build` first. Use `--assets DIR` to point it at your own folder. It listens on loopback only by default.

## Private/local assets

To see assets you must not publish (unlicensed, third-party characters) next to the public examples, put them in `local-assets/` (one `<type>-<name>` folder each, copied, not symlinked: the server refuses paths that resolve outside a root) and run:

```sh
npm run start:local   # serve.py --assets public/assets --local-assets local-assets
```

`--assets` and `--local-assets` are repeatable. Local items get `"collection": "local"` and a Local badge, and `--write-catalog` (`npm run catalog`) never includes them. `local-assets/` is git-ignored and must never be allow-listed in `.gitignore`. Run `npm run check` (private-file guard, unit and Python tests) before any push.

## Project layout

```
index.html                 page shell
src/app.js                 library, viewer, inspector, transport, scene backdrops
src/meadow.js              procedural 3D meadow (terrain, vegetation, pond, sky, weather)
src/fauna.js               wildlife behaviour on top of vendor/procedural-animals
src/insects.js             butterflies, dragonflies, fireflies
src/vmdplayer.js           VMD motion on a built-in mannequin
src/loaders/               local copy of three's FBXLoader that skips morph targets
src/style.css              styles
vendor/                    vendored code that is bundled by Vite (procedural-animals, mmdparser)
public/                    copied to the build as-is
public/catalog.json        generated asset catalogue
public/assets/<type>-<name>/   example assets, each with meta.json
public/vendor/             vendored pages loaded in iframes (shan-shui-inf, nonflowers, fishdraw)
serve.py                   optional local server
tests/                     tests
docs/                      architecture and format notes
```

See [docs/architecture.md](docs/architecture.md) for how the parts fit together and [docs/formats.md](docs/formats.md) for supported file formats.

## Coding style

Follow what the repo already does.

- ES modules, no framework, no TypeScript. Three.js is the only runtime dependency.
- Compact style: short functions, arrow functions, small helpers at the top of a file, several statements on one line where it stays readable.
- Comments only where they add information: why something is done, a non-obvious constraint, units, or where an idea came from. Do not restate the code.
- Match the surrounding code. Do not reformat lines you are not changing.
- Add a dependency only when the standard library, the browser or three.js cannot do the job.
- Python (`serve.py`) uses the standard library only.

## Tests

```sh
npm run test:py      # Python unittest for serve.py
npm run test:unit    # Node unit tests
```

If a script is not in `package.json` yet, the Python tests run with `python3 -m unittest discover -s tests`. Browser smoke tests (Playwright) are planned. Before opening a pull request, also run `npm run build` and open the app in a browser with the console visible: there must be no errors.

Add or update a test when you change `serve.py` or logic that can be tested without a browser.

## Asset policy

Only add assets that may be redistributed, with a licence you have verified on the source page.

- Accepted: CC0, public domain, CC BY, and similar licences that allow redistribution. For CC BY, keep the credit.
- "Free download" is not a licence. Do not commit an asset unless the source states a licence that allows redistribution.
- No franchise or trademarked characters and other third-party IP.
- No real-person likeness without that person's permission.
- No adult content in the example library. Items can carry a `sensitive` flag for private libraries, but the shipped examples must not need it.
- Record where the asset came from and what you changed.

To add an example asset:

1. Create `public/assets/<type>-<name>/` with the model and its textures. Types used so far: `animal`, `character`, `material`, `nature`, `test`, and `reference` for images.
2. Add `meta.json` with these fields: `name`, `description`, `license`, `author`, `source` (a page URL that states the licence) and `tags`. Optional: `sensitive`, `textureOverrides`.
3. Run `npm run catalog`. It rewrites `public/catalog.json`; commit the result.
4. Add a row to [ASSETS.md](ASSETS.md) with source, author, licence and changes, and the credit line if the licence requires one.

## Vendored code

Third-party code lives in `vendor/` (bundled by Vite) or `public/vendor/` (served as-is and loaded in iframes).

- Keep the upstream licence text next to the code, in a `LICENSE-*.txt` file.
- Add the component to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with upstream URL, licence, copyright holder and, where relevant, the upstream commit or version.
- Prefer unmodified copies. If you change a vendored file, list the file and what changed under "Locally modified files" in `THIRD_PARTY_NOTICES.md`.
- Only vendor code with a licence that permits redistribution. Nothing is loaded from a CDN at runtime.

## Commits

Write an imperative summary line, for example `Add wireframe toggle to the viewer` or `Fix FBX texture lookup for spaces in names`. Keep it under about 72 characters. Add a body when the reason is not obvious. One logical change per commit.

## Pull requests

Open the pull request against `main` with a short description of what changed and why. The template lists the checks:

- [ ] `npm run build` passes
- [ ] Tests pass
- [ ] No errors in the browser console
- [ ] Screenshots attached for UI changes
- [ ] Docs updated (`README`, `docs/`, `CHANGELOG.md`) where behaviour changed
- [ ] New assets follow the asset policy, and `ASSETS.md` and `catalog.json` are updated
- [ ] Vendored code is listed in `THIRD_PARTY_NOTICES.md`

By contributing you agree that your contribution is licensed under the project's [MIT licence](LICENSE).
