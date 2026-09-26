import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // Many "unit" tests do real work (PDF.js, WASM, big generated files). Alone the slowest take ~3 s, but the files run
  // in parallel and a full run on a busy machine roughly doubles that, so the 5 s default made the same few time out
  // on every full run. Genuine hangs still fail, just later.
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node', testTimeout: 20_000, setupFiles: ['tests/unit/helpers/engineSetup.ts'] }
})
