import type { IpcMainInvokeEvent } from 'electron'
import type { z } from 'zod'
import type { Controller } from '../controller'
import type { Repos } from '../db'
import type { FeatureKv } from '../db/repos'
import type { JobManager } from '../jobs/JobManager'
import type { FileService } from '../services/fileService'
import type { ManagedWindow, WindowManager } from '../windows/WindowManager'

/**
 * Everything a main-process feature can reach. A feature lives in `src/main/features/<name>/index.ts`
 * and exports `register(ctx)`; it is auto-loaded at startup (see ./index.ts).
 */
export interface MainContext {
  controller: Controller
  repos: Repos
  files: FileService
  jobs: JobManager
  windows: WindowManager
  /** Small persistent key/value state private to one feature: `ctx.kv('ocr').get('languages', ['eng'])`. */
  kv(feature: string): FeatureKv
  /** Absolute path of a document that is open in some window (never trust a path from the renderer). */
  pathOfDoc(docId: string): string | null
}

export interface FeatureCallContext {
  event: IpcMainInvokeEvent
  window: ManagedWindow | undefined
}

interface Registered {
  schema: z.ZodType
  fn: (req: never, ctx: FeatureCallContext) => unknown
}

const CHANNEL_RE = /^[a-z][a-zA-Z0-9]*:[a-zA-Z][a-zA-Z0-9]*$/
const channels = new Map<string, Registered>()
let windowsRef: WindowManager | null = null

export function bindFeatureWindows(w: WindowManager): void {
  windowsRef = w
}

/**
 * Registers a renderer-callable channel, e.g. `registerFeatureChannel('forms:listFields', schema, fn)`.
 * The renderer reaches it through `window.epdf.call(channel, payload)`; main rejects any channel that
 * was not registered here and validates every payload against `schema` before `fn` runs.
 * Channel names are `<feature>:<action>`; core channels (`file:`, `tabs:`, ...) cannot be redefined.
 */
export function registerFeatureChannel<S extends z.ZodType>(
  channel: string,
  schema: S,
  fn: (req: z.infer<S>, ctx: FeatureCallContext) => unknown
): void {
  if (!CHANNEL_RE.test(channel)) throw new Error(`Invalid feature channel name: ${channel}`)
  if (channels.has(channel)) throw new Error(`Feature channel already registered: ${channel}`)
  channels.set(channel, { schema, fn: fn as Registered['fn'] })
}

export async function callFeatureChannel(channel: string, payload: unknown, ctx: FeatureCallContext): Promise<unknown> {
  const reg = channels.get(channel)
  if (!reg) throw new Error(`Unknown feature channel: ${channel}`)
  const parsed = reg.schema.safeParse(payload)
  if (!parsed.success) throw new Error(`Invalid request for ${channel}: ${parsed.error.issues[0]?.message ?? 'bad payload'}`)
  return reg.fn(parsed.data as never, ctx)
}

/** Pushes an event to one window (or all windows). The renderer listens with `window.epdf.onFeature`. */
export function sendFeatureEvent(target: ManagedWindow | 'all', channel: string, payload: unknown): void {
  if (!windowsRef) return
  if (target === 'all') windowsRef.broadcast('feature:event', { channel, payload })
  else windowsRef.send(target, 'feature:event', { channel, payload })
}

/** Test helper. */
export function _resetFeatureChannels(): void {
  channels.clear()
}
