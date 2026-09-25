import type { MainContext } from './api'

type FeatureModule = { register?: (ctx: MainContext) => void }

// Every `src/main/features/<name>/index.ts` is a feature. Adding one never requires editing this file.
const modules = import.meta.glob<FeatureModule>('./*/index.ts', { eager: true })

export function loadFeatures(ctx: MainContext): void {
  for (const [path, mod] of Object.entries(modules)) {
    try {
      mod.register?.(ctx)
    } catch (err) {
      console.error(`Feature ${path} failed to register`, err)
    }
  }
}
