import {defineConfig, devices} from '@playwright/test';

// E2E_BASE_PATH (e.g. /open-3d-library/) serves the build under a sub-path, as GitHub Pages does.
const base = process.env.E2E_BASE_PATH || '/', origin = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: {timeout: 10_000},
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', {open: 'never'}]] : 'list',
  use: {
    baseURL: origin + base,
    trace: 'retain-on-failure',
    // Software WebGL (SwiftShader) so headless Chromium renders on macOS and on CI runners without a GPU.
    launchOptions: {args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']},
  },
  projects: [{name: 'chromium', use: {...devices['Desktop Chrome']}}],
  webServer: {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port 4173 --strictPort --base ${base}`,
    url: origin + base,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
