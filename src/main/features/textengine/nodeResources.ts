import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configureTextEngine } from '../../../shared/text/env'

/**
 * Resource loading for Node-like hosts: unit tests, the Electron main process and worker threads.
 *
 * The resources folder is found, in order, from: the explicit `dir` argument, `EPDF_RESOURCES_DIR`, the packaged
 * app's `process.resourcesPath` (installed builds ship `fonts/` and `text/` there through `extraResources`), and
 * `<cwd>/resources` (development and tests).
 */
export function findResourcesDir(dir?: string): string {
  const candidates: string[] = []
  if (dir) candidates.push(dir)
  if (process.env.EPDF_RESOURCES_DIR) candidates.push(process.env.EPDF_RESOURCES_DIR)
  const rp = (process as unknown as { resourcesPath?: string }).resourcesPath
  if (rp) candidates.push(rp)
  candidates.push(join(process.cwd(), 'resources'))
  for (const c of candidates) if (existsSync(join(c, 'text', 'harfbuzz.wasm'))) return c
  throw new Error(`Cannot find the text engine resources (looked in: ${candidates.join(', ')}). Set EPDF_RESOURCES_DIR.`)
}

const NAME_RE = /^(text\/[\w.-]+\.wasm|(fonts|textfonts)\/[\w.-]+\.(ttf|otf|json))$/

/** Read `name` (e.g. `fonts/NotoSans-Regular.ttf`) below `resourcesDir`. Names are validated: no path escapes. */
export async function readResource(resourcesDir: string, name: string): Promise<Uint8Array> {
  if (!NAME_RE.test(name)) throw new Error(`Invalid text resource name: ${name}`)
  const b = await readFile(join(resourcesDir, ...name.split('/')))
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
}

/** Configure the engine to read its resources from disk. Returns the resources folder used. */
export function useNodeResources(dir?: string): string {
  const resolved = findResourcesDir(dir)
  configureTextEngine({ loadResource: (name) => readResource(resolved, name) })
  return resolved
}
