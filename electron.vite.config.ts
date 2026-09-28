import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { thirdPartyNotices } from './scripts/lib/notices.mjs'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    plugins: [thirdPartyNotices()],
    build: { rollupOptions: { external: ['better-sqlite3'] } }
  },
  preload: {
    resolve: { alias: shared },
    plugins: [thirdPartyNotices()],
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].js' } } }
  },
  renderer: {
    resolve: { alias: shared },
    plugins: [react(), thirdPartyNotices()],
    // Web Workers are separate bundles; their packages belong in the notices too.
    worker: { plugins: () => [thirdPartyNotices()] },
    build: { chunkSizeWarningLimit: 2000 }
  }
})
