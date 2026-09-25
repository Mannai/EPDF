// Every `src/renderer/src/features/<name>/index.ts(x)` is a feature and registers itself on import.
// Adding a feature never requires editing this file.
import.meta.glob('./*/index.{ts,tsx}', { eager: true })

export {}
