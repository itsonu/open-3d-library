import {defineConfig} from 'vite';

// base './' lets the build run from any sub-path (e.g. GitHub Pages).
// assetsDir is not 'assets' because serve.py maps /assets/ to the user's asset folder.
export default defineConfig({base: './', build: {assetsDir: 'bundle'}});
