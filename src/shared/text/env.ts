/**
 * How the text engine finds its binary resources (the HarfBuzz WebAssembly modules, the bundled fonts and the
 * font catalogue). The engine itself is environment-neutral (Node, renderer, worker threads), so the host says how
 * to read a resource:
 *
 *   - Node / Electron main / worker threads: `useNodeResources()` from `@shared/text/node`
 *   - sandboxed renderer:                     `useRendererResources()` from `@shared/text/renderer`
 *
 * Resource names are relative to the app's resources folder: `text/harfbuzz.wasm`, `text/harfbuzz-subset.wasm`,
 * `fonts/<file>` and `textfonts/<file>` (see resources/textfonts/text-fonts.json for the catalogue).
 */

export type ResourceLoader = (name: string) => Promise<Uint8Array>

let loader: ResourceLoader | null = null
const cache = new Map<string, Promise<Uint8Array>>()

/** Tell the engine how to read resources. Call once at start-up (idempotent; later calls replace the loader). */
export function configureTextEngine(opts: { loadResource: ResourceLoader }): void {
  loader = opts.loadResource
  cache.clear()
}

export function isTextEngineConfigured(): boolean {
  return loader !== null
}

/** Read a resource (cached: the files are static). */
export function loadResource(name: string): Promise<Uint8Array> {
  if (!loader) {
    return Promise.reject(
      new Error(
        'The text engine has no resource loader. Call useNodeResources() (main/Node/worker) or useRendererResources() (renderer) once at start-up.'
      )
    )
  }
  let p = cache.get(name)
  if (!p) {
    p = loader(name)
    p.catch(() => cache.delete(name))
    cache.set(name, p)
  }
  return p
}
