import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { launch } from './helpers'

/** Help ▸ License, Third-Party Notices and End User License Agreement open the texts that ship with the app. */

test('Help ▸ License, Third-Party Notices and the EULA open the license texts that ship with the app', async () => {
  const { app, page } = await launch()
  try {
    await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible()
    // Record what the items would open instead of starting Notepad.
    const opened = await app.evaluate(async ({ Menu, shell }) => {
      const paths: string[] = []
      shell.openPath = async (p: string) => (paths.push(p), '')
      const items = Menu.getApplicationMenu()!.items.find((m) => m.role === 'help')!.submenu!.items
      for (const label of ['License', 'Third-Party Notices', 'End User License Agreement']) {
        const item = items.find((i) => i.label === label)!
        if (!item.enabled) throw new Error(`${label} is disabled`)
        item.click()
      }
      await new Promise((r) => setTimeout(r, 100))
      return paths
    })
    expect(opened).toHaveLength(3)
    // The agreement the installer asks the user to accept.
    const eula = readFileSync(opened[2], 'utf8')
    expect(eula).toContain('EPDF END USER LICENSE AGREEMENT')
    expect(eula).toContain('laws of the Kingdom of Bahrain')
    expect(eula).toContain('a legal agreement between you and Epdf ("the Licensor"')
    expect(eula).toContain('Copyright (c) 2026 Epdf. All rights reserved.')
    // Public contact addresses only: support for help, sales for commercial licenses.
    expect(eula).toContain('support@epdf.ing')
    expect(eula).toContain('write to sales@epdf.ing')
    expect(eula).not.toContain('@gmail.com')
    const license = readFileSync(opened[0], 'utf8')
    expect(license).toContain('PolyForm Strict License 1.0.0')
    expect(license).toContain('Copyright (c) 2026 Epdf.')
    expect(license).not.toContain('@gmail.com')
    expect(license).toContain('sales@epdf.ing')
    const notices = readFileSync(opened[1], 'utf8')
    // Bundled into the renderer (pdf-lib, PDF.js), shipped in node_modules (tesseract.js), and a bundled font.
    for (const text of ['pdf-lib 1.17.1', 'pdfjs-dist ', 'tesseract.js ', 'Apache License', 'SIL OPEN FONT LICENSE'])
      expect(notices, text).toContain(text)
  } finally {
    await app.close()
  }
})
