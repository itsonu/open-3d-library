# Third-party notices

This project includes or loads the following third-party components.

| Component | Upstream | Licence | Copyright holder | Licence text |
|---|---|---|---|---|
| shan-shui-inf | https://github.com/LingDong-/shan-shui-inf | MIT | (c) 2018 Lingdong Huang | `public/vendor/LICENSE-shanshui-inf.txt` |
| nonflowers | https://github.com/LingDong-/nonflowers | MIT | (c) 2018 Lingdong Huang | `public/vendor/LICENSE-nonflowers.txt` |
| fishdraw | https://github.com/LingDong-/fishdraw | MIT | (c) 2021 Lingdong Huang | `public/vendor/LICENSE-fishdraw.txt` |
| threejs-procedural-animals (vendored from `main` at c95ae49) | https://github.com/majidmanzarpour/threejs-procedural-animals | MIT | (c) 2026 Majid Manzarpour and contributors | `vendor/LICENSE-procedural-animals.txt` |
| Material Icons font (`public/vendor/nonflowers/fonts/MaterialIcons-Regular.ttf`) | https://github.com/google/material-design-icons | Apache License 2.0 | Copyright 2015 Google | `public/vendor/LICENSE-material-icons.txt` |
| three.js 0.186.1 (npm dependency, bundled at build time) | https://github.com/mrdoob/three.js | MIT | three.js authors | https://github.com/mrdoob/three.js/blob/dev/LICENSE |
| mmdparser.module.js (from three.js r160 `examples/jsm/libs`; mmd-parser by Takahiro, shipped with three.js) | https://github.com/mrdoob/three.js/blob/r160/examples/jsm/libs/mmdparser.module.js | MIT | three.js authors / Takahiro | https://github.com/mrdoob/three.js/blob/dev/LICENSE |

## Locally modified files

### threejs-procedural-animals

- `src/core/render/eyes.js`: added `uLocalInv`; eye shading is computed in animal-local space when the animal's parent is transformed.
- `src/core/render/coatMaterial.js`: fur/fin/seam metre offsets are scaled by the model-matrix scale.
- `src/core/render/animalObject.js`: `setQuality` accepts an exact shell count (`opts.shells`).

### three.js

- `src/loaders/FBXLoaderNoMorph.js`: copy of r186.1 `examples/jsm/loaders/FBXLoader.js` with imports rewritten to `three/addons/...` and morph-target parsing disabled (fallback for FBX files with broken blend shapes).

### mmdparser

- `vendor/mmdparser/mmdparser.module.js`: unmodified copy from three.js r160, used for VMD parsing.
