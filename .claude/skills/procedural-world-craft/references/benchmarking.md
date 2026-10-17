# Benchmarking browser scenes

Goal: numbers that compare like with like and survive scrutiny. GPU clocks on laptops can drift by about 2× between sessions, and live scenes change on their own (animals move, adaptive quality thins vegetation). Design the measurement so neither corrupts the comparison.

## Protocol

1. **Fix the render target.** Set `renderer.setPixelRatio(1); renderer.setSize(1280, 720, false); camera.aspect = 16/9`, and do this *inside the same synchronous call* as the measurement: viewers often have a ResizeObserver that resets the size between calls. Measure native resolution separately and record its size and DPR.
2. **Fix the scene.**
   - Use default parameters and a fixed seed.
   - Reset the camera, and turn off auto-rotate and control damping.
   - Freeze behaviour (replace the per-frame animal update with a no-op) after placing subjects at **known screen-height fractions**, e.g. 25%, 10%, 7%, 4% and 3% of the viewport.
   - Advance LOD or transition timers until they settle, then confirm the tier of every subject.
3. **Time CPU and GPU separately.** For each frame:
   - `t1 = now(); update(); t2 = now(); renderer.render(); t3 = now(); gl.readPixels(0,0,1,1,…); t4 = now();`
   - CPU update is `t2−t1`, CPU submit is `t3−t2`, and GPU wait is `t4−t3`.
   - Use 20+ warm-up frames, then 40–100 timed frames. Report the median and p90.
4. **Attribute the cost by toggling one thing at a time:** hide a subsystem or a single object, disable shadow casting, freeze the shadow map (`renderer.shadowMap.autoUpdate = false`), or hide one mesh type (e.g. fur shells).
5. **Fill-bound or vertex-bound?** Repeat the toggle at 1280×720 and at 640×360. A cost that does not shrink with pixel count is geometry or vertex work, so LOD and culling help. A cost that shrinks is fill or fragment work, so shader and overdraw changes help.
6. **Paired before/after.** Alternate before, after, before, after in the same session, and repeat when results disagree.
   - For shader changes, A/B *within one page load*: clone the material with a different `customProgramCacheKey()` and an edited `onBeforeCompile`, then swap `mesh.material`.
   - For runtime parameters, toggle them in place, for example tier thresholds set to "always full quality" against the new thresholds.
7. **Visual equivalence for optimisations.** Render a deterministic frame (fixed time uniform) before and after and compare the pixels. Isolate the changed subsystem (e.g. terrain only) so nondeterministic systems such as adaptive density don't pollute the difference.
8. **Report:**
   - GPU, browser and OS.
   - Render size and DPR.
   - The layout description.
   - Median and p90 for each run.
   - Draw calls, triangles and program count.
   - Shader-compile errors (`renderer.info.programs[i].diagnostics`).
   - Console errors.
   - What was frozen.

   State targets as measurements on a named machine, never as universal frame rates.

## Pitfalls seen in practice

- Benchmark helpers that run more than ~5 s in one page script can time out in automation tools. Split them across calls and keep state on `window`.
- Cross-load comparisons are unreliable when the scene adapts to frame time. Prefer in-page A/B.
- A hidden pane's measurements are meaningless. Use the readPixels sync and a visible pane.
