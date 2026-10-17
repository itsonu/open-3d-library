# Example assets

Every file under `public/assets/` is listed here with its source, author and licence. Licences were checked on the source page on 2026-10-17. The project's MIT licence covers the code only; these assets keep their own licences.

Assets under **CC BY 4.0** may be redistributed and modified, but the credit below must be kept with them. CC0 and public-domain assets carry no obligations; they are credited anyway.

| Folder | Asset | Author | Licence | Source | Changes |
|---|---|---|---|---|---|
| `animal-fox` | Fox | PixelMannen (model); tomkranis (rigging & animation); @AsoboStudio and @scurest (glTF conversion) | CC0-1.0 (model) + CC-BY-4.0 (rig, animation, glTF conversion) | [github.com](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/Fox) | Unmodified (glTF-Binary). |
| `character-rigged-figure` | Rigged figure | Cesium | CC-BY-4.0 | [github.com](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/RiggedFigure) | Unmodified (glTF-Binary). |
| `material-glass-vase-flowers` | Glass vase with flowers | Eric Chadwick (vase), Rico Cilliers (flowers) | CC0-1.0 | [github.com](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/GlassVaseFlowers) | Unmodified (glTF-Binary). |
| `material-sheen-chair` | Sheen chair | Eric Chadwick (Wayfair, LLC) | CC0-1.0 | [github.com](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/SheenChair) | Unmodified (glTF-Binary). |
| `nature-fern` | Fern | Rob Tuytel (scanning), Rico Cilliers (modeling), Poly Haven | CC0-1.0 | [polyhaven.com](https://polyhaven.com/a/fern_02) | 1k glTF as published. |
| `nature-rock` | Rock | Jenelle van Heerden, Poly Haven | CC0-1.0 | [polyhaven.com](https://polyhaven.com/a/rock_09) | 1k glTF as published. |
| `test-fbx-moon-rock` | Moon rock (FBX) | Rico Cilliers, Greg Zaal (photography), Jenelle van Heerden (processing), Poly Haven | CC0-1.0 | [polyhaven.com](https://polyhaven.com/a/moon_rock_02) | Kept only the 1k FBX and diffuse JPEG (EXR normal/roughness maps omitted). |
| `test-morph-stress` | Morph stress test | Ed Mackey, Analytical Graphics, Inc. | CC-BY-4.0 | [github.com](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/MorphStressTest) | Unmodified (glTF-Binary). |
| `test-obj-spot` | Spot (OBJ) | Keenan Crane | Public domain (author dedication) | [www.cs.cmu.edu](https://www.cs.cmu.edu/~kmcrane/Projects/ModelRepository/) | Added `spot_triangulated.mtl` (points the OBJ at its texture); kept only the triangulated mesh and PNG texture. |

## Required attribution (CC BY 4.0)

- **Fox**: model by PixelMannen (CC0); rigging and animation by tomkranis (CC BY 4.0); glTF conversion by @AsoboStudio and @scurest (CC BY 4.0). Source: Khronos glTF-Sample-Assets.
- **Rigged figure**: © 2017 Cesium, CC BY 4.0. Source: Khronos glTF-Sample-Assets.
- **Morph stress test**: © 2021 Analytical Graphics, Inc., Ed Mackey, CC BY 4.0. Source: Khronos glTF-Sample-Assets.

Licence texts: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/legalcode), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode). The same details are stored per asset in `public/assets/<folder>/meta.json` and shown in the app.

## Adding an asset

1. Create `public/assets/<type>-<name>/` with the model and its textures.
2. Add `meta.json` with `name`, `description`, `license`, `author`, `source` and `tags`.
3. Run `npm run catalog` to regenerate `public/catalog.json`, and add a row above.
4. Only add assets whose licence permits redistribution (CC0, CC BY, public domain or similar), with a source page that states it. "Free to download" is not a licence.
