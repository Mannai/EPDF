import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { launch } from './helpers'

/** Help ▸ License and Help ▸ Third-Party Notices open the license texts that ship with the app. */

test('Help ▸ License and Third-Party Notices open the license texts that ship with the app', async () => {
  const { app, page } = await launch()
  try {
    await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible()
    // Record what the items would open instead of starting Notepad.
    const opened = await app.evaluate(async ({ Menu, shell }) => {
      const paths: string[] = []
      shell.openPath = async (p: string) => (paths.push(p), '')
      const items = Menu.getApplicationMenu()!.items.find((m) => m.role === 'help')!.submenu!.items
      for (const label of ['License', 'Third-Party Notices']) {
        const item = items.find((i) => i.label === label)!
        if (!item.enabled) throw new Error(`${label} is disabled`)
        item.click()
      }
      await new Promise((r) => setTimeout(r, 100))
      return paths
    })
    expect(opened).toHaveLength(2)
    const license = readFileSync(opened[0], 'utf8')
    expect(license).toContain('PolyForm Strict License 1.0.0')
    expect(license).toContain('Meshal AlMannai')
    const notices = readFileSync(opened[1], 'utf8')
    // Bundled into the renderer (pdf-lib, PDF.js), shipped in node_modules (tesseract.js), and a bundled font.
    for (const text of ['pdf-lib 1.17.1', 'pdfjs-dist ', 'tesseract.js ', 'Apache License', 'SIL OPEN FONT LICENSE'])
      expect(notices, text).toContain(text)
  } finally {
    await app.close()
  }
})
