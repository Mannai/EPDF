import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Runs against a real packaged build:
//   npx electron-builder --win --dir --publish never
//   $env:EPDF_PACKAGED_EXE = "dist\win-unpacked\Epdf.exe"; npx playwright test tests/e2e/text-engine-packaged.spec.ts
const exe = process.env['EPDF_PACKAGED_EXE']

test.describe('text engine in the packaged build', () => {
  test.skip(!exe, 'set EPDF_PACKAGED_EXE to the packaged executable to run this')

  test('HarfBuzz WebAssembly and the bundled fonts work from the installed resources (renderer and main process)', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'epdf-pkg-text-'))
    const env = { ...process.env, EPDF_USER_DATA: userData, ELECTRON_RENDERER_URL: '' } as Record<string, string>
    const app = await electron.launch({ executablePath: exe!, args: [], env })
    try {
      expect(await app.evaluate(({ app: a }) => a.isPackaged)).toBe(true)
      const page = await app.firstWindow()
      await page.waitForFunction(() => !!window.__epdfTextEngine, undefined, { timeout: 60_000 })

      // Renderer: WebAssembly under the CSP, resources over the channel from process.resourcesPath.
      const r = await page.evaluate(() => window.__epdfTextEngine!.selfTest('مرحبا بالعالم ١٢٣ English 你好 नमस्ते สวัสดี שלום', { width: 260, size: 14 }))
      expect(r.missing).toEqual([])
      expect(r.fonts.join(' ')).toMatch(/Arabic|Naskh/)
      expect(Buffer.from(r.pdf, 'base64').subarray(0, 5).toString('latin1')).toBe('%PDF-')

      // Main process (and worker threads use the same Node loader): asar + extraResources.
      const m = await page.evaluate(() => window.epdf.call<{ lines: number; missing: string[]; fonts: string[]; pdfBytes: number; packaged: boolean }>('text:selfTest', { text: 'مرحبا بالعالم שלום 你好 नमस्ते สวัสดี' }))
      expect(m.packaged).toBe(true)
      expect(m.missing).toEqual([])
      expect(m.fonts.length).toBeGreaterThanOrEqual(4)
      expect(m.pdfBytes).toBeGreaterThan(1000)

      // A resource that is not on the whitelist is refused (no path escapes).
      await expect(page.evaluate(() => window.epdf.call('text:resource', { name: '../../package.json' }))).rejects.toThrow()
    } finally {
      await app.close()
    }
  })
})
