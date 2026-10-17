# Performance

These are measurements, not guarantees. Frame time depends on the GPU, the browser, the output resolution and the scene. Numbers below come from one reference machine and are only comparable within the same session.

## Method

- **Render target:** a fixed 1280×720 at pixel ratio 1. Native resolution is measured separately.
- **Scene:**
  - Default meadow parameters and a fixed seed.
  - Camera reset; auto-rotate and control damping off.
  - Animals placed at fixed shares of the screen height (25%, 10%, 7%, 4% and 3%), with behaviour frozen.
  - LOD transitions settled before measuring.
- **Timing:** each frame is `renderer.render()` followed by a 1-pixel `gl.readPixels`, which waits for the GPU. 20 warm-up frames, then 40–100 timed frames. Median and p90 reported.
- **Comparisons:** paired runs (before, after, before, after) in the same session, because laptop GPU clocks drift by up to about 2× between sessions.
- **Also recorded:** draw calls, triangles and shader programs (`renderer.info`), and shader-compile failures (`renderer.info.programs[i].diagnostics`).

The full protocol, including how to tell fill-bound from vertex-bound costs, is in [`.claude/skills/procedural-world-craft/references/benchmarking.md`](../.claude/skills/procedural-world-craft/references/benchmarking.md).

## Results (2026-10-17)

Reference machine: Apple M5 (ANGLE Metal), Chromium 152, macOS.

| Scene | Size | Median | p90 | Draw calls | Triangles | Shader errors |
|---|---|---|---|---|---|---|
| Model only: 942k-triangle FBX, meadow hidden | 1280×720 | 2.4 ms | 2.8 ms | 2 | 1.88M (incl. shadow pass) | 0 |
| Meadow + five animals, before fur LOD | 1280×720 | 18.9–23.9 ms | 20.9–26.9 ms | 123 | 5.96M | 0 |
| Meadow + five animals, with fur LOD | 1280×720 | 10.1–14.6 ms | 12.2–16.7 ms | 123–166 | 2.74M | 0 |
| Meadow + five animals, with fur LOD | 748×1422 (native) | 9.8–10.0 ms | 10.5 ms | 101 | 2.63M | 0 |

The meadow's main costs:
- **Animal fur shells.** These are geometry-bound: about 30k skinned vertices per shell layer per animal.
- **Terrain shading.** This is fill-bound.

Shadows, eyes and draw calls are minor. Fur layers scale with each animal's share of the screen (16 for close-ups down to 3, and none off screen).
