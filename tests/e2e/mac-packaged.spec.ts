import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fixture, menuClick } from './helpers'

/**
 * macOS behaviour of the built app, driven through Launch Services (`open`) the way Finder and the Dock drive it:
 *   npm run dist:mac
 *   EPDF_PACKAGED_EXE=dist/mac-universal/Epdf.app/Contents/MacOS/Epdf npx playwright test mac-packaged
 * The update test also needs a test build (the only kind that honours EPDF_UPDATE_URL):
 *   npx electron-builder --mac --dir --arm64 --config.extraMetadata.epdfTestBuild=true --config.directories.output=dist-test
 *   EPDF_PACKAGED_TEST_EXE=dist-test/mac-arm64/Epdf.app/Contents/MacOS/Epdf
 */
const exe = process.env['EPDF_PACKAGED_EXE']
const testExe = process.env['EPDF_PACKAGED_TEST_EXE']
const bundleOf = (executable: string): string => resolve(executable, '..', '..', '..')

const launchApp = (executable: string, extraEnv: Record<string, string> = {}): Promise<ElectronApplication> =>
  electron.launch({
    executablePath: executable,
    args: [],
    env: { ...process.env, EPDF_USER_DATA: mkdtempSync(join(tmpdir(), 'epdf-mac-')), ELECTRON_RENDERER_URL: '', ...extraEnv } as Record<string, string>
  })

test.describe('macOS packaged app', () => {
  test.skip(process.platform !== 'darwin', 'macOS only')

  test('app menu, the last window closing, the Dock bringing a window back, and Finder opening a PDF', async () => {
    test.skip(!exe, 'set EPDF_PACKAGED_EXE to Epdf.app/Contents/MacOS/Epdf')
    const app = await launchApp(exe!)
    try {
      await app.firstWindow()
      // The Epdf menu with About, Hide and Quit (Cmd+Q comes with the role); Edit has Cut / Copy / Paste.
      const menus = await app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()!.items.map((m) => ({
          label: m.label,
          roles: (m.submenu?.items ?? []).map((i) => (i.role ?? '').toLowerCase()),
          labels: (m.submenu?.items ?? []).map((i) => i.label)
        }))
      )
      expect(menus[0]!.label).toBe('Epdf')
      expect(menus[0]!.labels).toEqual(expect.arrayContaining(['About Epdf', 'Hide Epdf', 'Quit Epdf']))
      expect(menus[0]!.roles).toEqual(expect.arrayContaining(['about', 'hide', 'hideothers', 'unhide', 'quit', 'services']))
      expect(menus.find((m) => m.label.replace('&', '') === 'Edit')!.roles).toEqual(expect.arrayContaining(['cut', 'copy', 'paste', 'selectall']))

      // Closing the last window leaves Epdf running (as Mac apps do).
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0)
      await new Promise((r) => setTimeout(r, 1000))
      expect(app.process().exitCode).toBeNull()

      // Clicking the Dock icon (Launch Services' "reopen") opens a window again.
      const reopened = app.waitForEvent('window')
      execFileSync('open', ['-g', '-a', bundleOf(exe!)])
      const page = await reopened
      await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible()

      // Double-clicking a PDF in Finder / dropping it on the Dock icon: the running app opens it (open-file).
      execFileSync('open', ['-g', '-a', bundleOf(exe!), fixture('sample.pdf')])
      await expect(page.getByRole('tab', { name: /sample\.pdf/ })).toBeVisible()
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    } finally {
      await app.close()
    }
  })

  test('an update is announced with its download page; nothing is downloaded', async () => {
    test.skip(!testExe, 'set EPDF_PACKAGED_TEST_EXE to a test build (see the top of this file)')
    const requests: string[] = []
    const feed = 'version: 9.9.9\nfiles:\n  - url: Epdf-9.9.9-universal.zip\n    sha512: AAAA\n    size: 4\npath: Epdf-9.9.9-universal.zip\nsha512: AAAA\nreleaseDate: 2026-09-29T00:00:00.000Z\n'
    const server: Server = createServer((req, res) => {
      requests.push(req.url ?? '')
      if (/-mac\.yml(\?|$)/.test(req.url ?? '')) res.writeHead(200, { 'content-type': 'text/yaml' }).end(feed)
      else res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const app = await launchApp(testExe!, { EPDF_UPDATE_URL: `http://127.0.0.1:${port}/` })
    try {
      await app.firstWindow()
      await app.evaluate(({ dialog, shell }) => {
        const g = globalThis as { __asked?: unknown[]; __opened?: string[] }
        g.__asked = []
        g.__opened = []
        ;(dialog as unknown as { showMessageBox: (...a: unknown[]) => Promise<unknown> }).showMessageBox = async (...a: unknown[]) => {
          const o = (a.length > 1 ? a[1] : a[0]) as { message: string; buttons?: string[] }
          g.__asked!.push({ message: o.message, buttons: o.buttons })
          return { response: 0, checkboxChecked: false } // "Open Download Page"
        }
        ;(shell as unknown as { openExternal: (u: string) => Promise<void> }).openExternal = async (u: string) => void g.__opened!.push(u)
      })
      await menuClick(app, 'Help', 'Check for Updates…')
      await expect.poll(() => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened)).toEqual(['https://github.com/Mannai/EPDF/releases/tag/v9.9.9'])
      const asked = await app.evaluate(() => (globalThis as { __asked?: unknown[] }).__asked)
      expect(asked).toEqual([{ message: 'Epdf 9.9.9 is available', buttons: ['Open Download Page', 'Not Now'] }])
      await new Promise((r) => setTimeout(r, 1500))
      expect(requests.some((u) => /\.zip|\.dmg/.test(u))).toBe(false) // only the feed file was read
      expect(requests.some((u) => /-mac\.yml/.test(u))).toBe(true)
    } finally {
      await app.close()
      server.close()
    }
  })
})
