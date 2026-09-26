import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

/**
 * The engine must run in worker threads (jobs run there in the Electron main process). This bundles the engine the way
 * electron-vite does for `?nodeWorker` (a single CommonJS file, dependencies inlined), starts a real worker thread and
 * has it lay out, draw and save a PDF with Arabic text, then checks the bytes in the main thread.
 */
describe('worker threads', () => {
  it('lays out and draws Arabic text inside a worker_threads Worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epdf-text-worker-'))
    mkdirSync(dir, { recursive: true })
    const entry = join(dir, 'entry.ts')
    const root = resolve('.').replace(/\\/g, '/')
    writeFileSync(
      entry,
      `
import { parentPort, workerData } from 'node:worker_threads'
import { PDFDocument } from 'pdf-lib'
import { useNodeResources } from '${root}/src/main/features/textengine/nodeResources'
import { drawParagraph } from '${root}/src/shared/text/pdf/draw'
import { layoutParagraph } from '${root}/src/shared/text/layout'

async function main() {
  useNodeResources(workerData.resources)
  const text = 'مرحبا بالعالم Hello ١٢٣ (اختبار)'
  const layout = await layoutParagraph(text, { size: 16, width: 200 })
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([300, 200])
  const r = await drawParagraph(page, text, { x: 20, y: 180, width: 200, size: 16 })
  const bytes = await pdf.save()
  parentPort!.postMessage({ bytes, lines: layout.lines.length, missing: r.missing.length, thread: true })
}
main().catch((e) => parentPort!.postMessage({ error: String(e && e.stack || e) }))
`
    )
    const out = join(dir, 'worker.cjs')
    await build({
      entryPoints: [entry],
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      logLevel: 'silent',
      external: ['node:*'],
      alias: { '@shared': resolve('src/shared') },
      nodePaths: [resolve('node_modules')],
      loader: { '.mjs': 'js' }
    })
    const result = await new Promise<{ bytes?: Uint8Array; lines?: number; missing?: number; error?: string }>((res, rej) => {
      const w = new Worker(out, { workerData: { resources: resolve('resources') } })
      w.once('message', (m) => {
        res(m)
        void w.terminate()
      })
      w.once('error', rej)
      w.once('exit', (c) => c !== 0 && rej(new Error(`worker exited with ${c}`)))
    })
    expect(result.error).toBeUndefined()
    expect(result.missing).toBe(0)
    expect(result.lines).toBeGreaterThan(1)
    const bytes = result.bytes as Uint8Array
    expect(new TextDecoder('latin1').decode(bytes.slice(0, 5))).toBe('%PDF-')
    const { pdfjsLines } = await import('./helpers/text')
    const text = (await pdfjsLines(bytes)).join(' ').normalize('NFKC').replace(/\s+/g, ' ')
    expect(text).toContain('مرحبا بالعالم')
    expect(text).toContain('Hello')
  }, 60_000)
})
