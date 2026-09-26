import { configureTextEngine } from './env'

/**
 * Resource loading for the sandboxed renderer: the bytes are requested from the main process over the validated
 * feature channel `text:resource` (implemented in src/main/features/textengine). Call once before the first use.
 */
export function useRendererResources(): void {
  const epdf = (globalThis as unknown as { epdf?: { call<T>(channel: string, payload: unknown): Promise<T> } }).epdf
  if (!epdf) throw new Error('useRendererResources() needs window.epdf (the preload bridge)')
  configureTextEngine({
    loadResource: async (name) => {
      const b = await epdf.call<Uint8Array>('text:resource', { name })
      return new Uint8Array(b)
    }
  })
}
