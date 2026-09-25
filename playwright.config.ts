import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1, // each test launches a real Electron app
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts'
})
