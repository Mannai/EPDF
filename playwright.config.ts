import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Each test launches its own Electron app with its own profile, so test files run side by side. The one shared
  // resource, the system clipboard, is guarded by withSystemClipboard() in helpers.ts. EPDF_E2E_WORKERS=1 runs them
  // one at a time (e.g. to rule out interference when chasing a flaky test).
  workers: Number(process.env['EPDF_E2E_WORKERS'] ?? 4),
  // Linux (a virtual display with software rendering, often a VM): under parallel load Chromium sometimes drops the
  // last steps of a synthetic drag. One retry there, reported as "flaky" rather than hidden; none elsewhere.
  retries: Number(process.env['EPDF_E2E_RETRIES'] ?? (process.platform === 'linux' ? 1 : 0)),
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts'
})
