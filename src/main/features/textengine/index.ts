import { app } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import { readResource, useNodeResources } from './nodeResources'
import type { MainContext } from '../api'
import { registerFeatureChannel } from '../api'

/**
 * Main-process half of the text engine (src/shared/text). It serves the engine's binary resources to the sandboxed
 * renderer over the validated channel `text:resource` (the HarfBuzz WebAssembly modules, the bundled fonts and the font
 * catalogue) and configures the engine for use inside the main process and its worker threads.
 *
 * The renderer never names a path: it sends a resource name that must match the whitelist in ./nodeResources.ts.
 * `text:selfTest` runs the engine in the main process (diagnostics for the end-to-end and packaged-build tests).
 */

const resourcesDir = (): string => (app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'))

const NameSchema = z.object({ name: z.string().max(120).regex(/^(text\/[\w.-]+\.wasm|(fonts|textfonts)\/[\w.-]+\.(ttf|otf|json))$/) })
const SelfTestSchema = z.object({ text: z.string().max(4000) })

export function register(_ctx: MainContext): void {
  useNodeResources(resourcesDir())
  registerFeatureChannel('text:resource', NameSchema, ({ name }) => readResource(resourcesDir(), name))

  registerFeatureChannel('text:selfTest', SelfTestSchema, async ({ text }) => {
    const [{ PDFDocument }, engine] = await Promise.all([import('pdf-lib'), import('../../../shared/text')])
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([400, 300])
    const r = await engine.drawParagraph(page, text, { x: 20, y: 280, width: 360, size: 16 })
    const bytes = await pdf.save()
    return {
      lines: r.lineCount,
      missing: r.missing.map((m) => m.char),
      fonts: engine.embeddedFontsFor(pdf).all().map((f) => f.font.family),
      pdfBytes: bytes.length,
      packaged: app.isPackaged
    }
  })
}
