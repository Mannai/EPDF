import * as HB from './vendor/harfbuzz/index.mjs'
import { loadResource } from './env'

/**
 * HarfBuzz (harfbuzzjs, MIT) with the WebAssembly supplied by the host instead of fetched relative to the module
 * (see vendor/harfbuzz/index.mjs for the one-line patch). Loaded once per JS realm.
 */
export type HarfBuzz = typeof HB

let loading: Promise<HarfBuzz> | null = null
let loaded: HarfBuzz | null = null

export function loadHarfBuzz(): Promise<HarfBuzz> {
  if (!loading) {
    loading = loadResource('text/harfbuzz.wasm')
      .then(async (wasm) => {
        await HB.initHarfBuzz({ wasmBinary: wasm })
        loaded = HB
        return HB
      })
      .catch((e) => {
        loading = null
        throw e
      })
  }
  return loading
}

/** HarfBuzz once `loadHarfBuzz()` has resolved (the layout core is synchronous after its async preparation). */
export function hbSync(): HarfBuzz {
  if (!loaded) throw new Error('HarfBuzz is not loaded yet: await loadHarfBuzz() (layoutParagraph/drawText do this for you)')
  return loaded
}
