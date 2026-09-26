import { app } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import { readResource, useNodeResources } from '../../../shared/text/node'
import type { MainContext } from '../api'
import { registerFeatureChannel } from '../api'

/**
 * Main-process half of the text engine (src/shared/text). It serves the engine's binary resources to the sandboxed
 * renderer over the validated channel `text:resource` (the HarfBuzz WebAssembly modules, the bundled fonts and the font
 * catalogue) and configures the engine for use inside the main process and its worker threads.
 *
 * The renderer never names a path: it sends a resource name that must match the whitelist in shared/text/node.ts.
 */

const resourcesDir = (): string => (app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'))

const NameSchema = z.object({ name: z.string().max(120).regex(/^(text\/[\w.-]+\.wasm|(fonts|textfonts)\/[\w.-]+\.(ttf|otf|json))$/) })

export function register(_ctx: MainContext): void {
  useNodeResources(resourcesDir())
  registerFeatureChannel('text:resource', NameSchema, ({ name }) => readResource(resourcesDir(), name))
}
