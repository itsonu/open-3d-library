# Supported formats

| Format | Extensions | Status |
|---|---|---|
| glTF 2.0 | `.glb`, `.gltf` | Primary format |
| FBX | `.fbx` | Supported |
| Wavefront OBJ + MTL | `.obj`, `.mtl` | Supported |
| MMD motion | `.vmd` | Motion only, plays on a built-in mannequin |
| Images | `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` | Gallery for `reference-*` items; also used as textures |
| Audio | `.wav`, `.mp3`, `.ogg`, `.m4a` | Optional soundtrack for the animation transport |

When a library item has more than one model file, a selector in the viewer header switches between them. The preferred order is GLB, glTF, FBX, OBJ.

PMX and PMD model files are not supported.

## glTF / GLB

Loaded with three's `GLTFLoader` (three r186). Works:

- PBR metallic-roughness materials with normal, occlusion and emissive maps
- Skinning, skeleton display, and animation clips (the clip list and transport apply)
- Morph targets
- Material extensions that three r186 implements, for example `KHR_materials_sheen`, `_transmission`, `_volume`, `_clearcoat`, `_ior`, `_specular`, `_iridescence`, `_anisotropy`, `_dispersion`, `_emissive_strength`, `_unlit`, plus `KHR_texture_transform`, `KHR_mesh_quantization`, `EXT_texture_webp` and `EXT_texture_avif`
- `KHR_materials_variants` is parsed by three, but the viewer has no variant switcher: you see the default materials

Not supported: files compressed with Draco (`KHR_draco_mesh_compression`), Meshopt (`EXT_meshopt_compression`, `KHR_meshopt_compression`) or KTX2/Basis textures (`KHR_texture_basisu`). `src/app.js` does not configure `DRACOLoader`, `MeshoptDecoder` or `KTX2Loader`, and the decoders are not bundled, so such files fail to load. Decompress them first, for example with `gltf-transform` or Blender.

Multi-file glTF (a `.gltf` plus `.bin` and image files): open or drop the whole folder, so the loader can find the siblings. In a library item, keep all the files in the item's folder.

## FBX

Binary and ASCII FBX are loaded with three's `FBXLoader`. Notes:

- If the stock loader throws a `TypeError`, which happens with some exports that have broken blend-shape data, the file is loaded again with a local copy of the loader that skips morph targets. Such a model loads without its shape keys.
- Textures are found by name from image files next to the model, ignoring the folder path in the file (for example `tmp123.fbm/image_0_png` is matched against the files in the item). If an export lost its links, the viewer tries to match image files to materials by name and role (colour, normal, bump). Models with a single material and no texture take the folder's colour image.
- Maps whose image cannot be found or loaded are removed, so they do not render black.
- Animations stored in the file appear in the clip list.

## OBJ + MTL

`OBJLoader` with `MTLLoader`. The material library is read from a `.mtl` with the same base name as the `.obj`; if it is missing or fails to load, the model loads with default materials. Texture paths in the `.mtl` resolve to image files next to the model by name. OBJ has no rig or animation.

## VMD

VMD is an MMD motion file. It has no geometry, so the viewer plays it on a built-in mannequin that uses the standard MMD bone names. Arms, spine and head follow the keyframes; legs come from the foot-IK bones. Only bones the mannequin has are animated. If the item has an audio file, it plays on the same timeline.

## Images

Items of type `reference` with images and no 3D model open as a gallery of thumbnails with a lightbox (zoom and pan). Thumbnails are made by `serve.py` on macOS only (using `sips`); elsewhere the full image is used.

## Known limitations

- EXR, TIFF, PSD and other image formats the browser cannot decode are skipped as textures, so a model that relies on them shows without those maps. Convert them to PNG or JPEG. (The example Moon rock FBX keeps only its diffuse JPEG for this reason.)
- Draco, Meshopt and KTX2 compressed glTF files do not load (see above).
- No variant switching for `KHR_materials_variants`.
