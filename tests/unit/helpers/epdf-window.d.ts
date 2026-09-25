import type { EpdfApi } from '../../../src/shared/ipc'

// Unit tests that import renderer modules (with the browser APIs faked) are type-checked by tsconfig.node.json,
// which does not include src/preload/index.d.ts; this gives them the same `window.epdf` type.
declare global {
  interface Window {
    epdf: EpdfApi
  }
}
