import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { axeViolations, crash, currentPage, fixture, gotoPage, launch } from './helpers'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string

test.describe('shell: tabs, windows, session, security', () => {
  test('second launch hands its file to the running instance as a new tab', async () => {
    const { app, page, userData } = await launch({ files: [fixture('sample.pdf')] })
    try {
      await expect(page.getByRole('tab')).toHaveCount(1)
      const child = spawn(electronPath, ['.', fixture('mixed.pdf')], {
        env: { ...process.env, EPDF_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
        stdio: 'ignore'
      })
      const exited = new Promise<number | null>((r) => child.on('exit', r))
      await exited // the second instance must quit by itself (single-instance lock)
      await expect(page.getByRole('tab')).toHaveCount(2)
      await expect(page.getByRole('tab', { name: /mixed\.pdf/ })).toHaveAttribute('aria-selected', 'true')

      // Keyboard: arrow keys move between tabs (WAI-ARIA tabs pattern).
      await page.getByRole('tab', { name: /mixed\.pdf/ }).focus()
      await page.keyboard.press('ArrowLeft')
      await expect(page.getByRole('tab', { name: /sample\.pdf/ })).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('toolbar').getByText('/ 5')).toBeVisible()

      // Close by button; the other tab becomes active.
      await page.locator('[data-close="sample.pdf"]').click()
      await expect(page.getByRole('tab')).toHaveCount(1)
      await expect(page.getByRole('toolbar').getByText('/ 4')).toBeVisible()
      // Keyboard equivalent of the ✕: Delete on the focused tab.
      await page.getByRole('tab', { name: /mixed\.pdf/ }).focus()
      await page.keyboard.press('Delete')
      await expect(page.getByText('Recent files')).toBeVisible()
      // The recent list remembers both.
      await expect(page.getByRole('button', { name: /^sample\.pdf/ })).toBeVisible()
    } finally {
      await app.close()
    }
  })

  test('moving a tab to a new window opens a second window with the same document and page', async () => {
    const { app, page } = await launch({ files: [fixture('sample.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await gotoPage(page, 4)
      await expect.poll(() => currentPage(page)).toBe('4')
      await app.evaluate(({ Menu }) => {
        const doc = Menu.getApplicationMenu()!.items.find((i) => i.label.replace('&', '') === 'Document')!
        doc.submenu!.items.find((i) => i.label === 'Move Tab to New Window')!.click()
      })
      await expect.poll(() => app.windows().length).toBe(2)
      const second = app.windows().find((w) => w !== page)!
      await expect(second.getByRole('tab', { name: /sample\.pdf/ })).toBeVisible()
      await expect.poll(() => second.getByLabel('Page number').inputValue()).toBe('4')
      await expect(page.getByText('Recent files')).toBeVisible() // source window is now empty
    } finally {
      await app.close()
    }
  })

  test('native menu actions drive the viewer', async () => {
    const { app, page } = await launch({ files: [fixture('sample.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const click = (menu: string, item: string) =>
        app.evaluate(
          ({ Menu }, [m, i]) => {
            const top = Menu.getApplicationMenu()!.items.find((x) => x.label.replace('&', '') === m)!
            top.submenu!.items.find((x) => x.label.replace('&', '') === i)!.click()
          },
          [menu, item]
        )
      await click('Document', 'Last Page')
      await expect.poll(() => currentPage(page)).toBe('5')
      await click('Document', 'First Page')
      await expect.poll(() => currentPage(page)).toBe('1')
      await click('View', 'Actual Size')
      await expect(page.getByLabel('Zoom level')).toHaveValue('100')
      await click('View', 'Zoom In')
      await expect(page.getByLabel('Zoom level')).toHaveValue('110')
      await click('View', 'Toggle Sidebar')
      await expect(page.getByLabel('Page thumbnails')).toHaveCount(0)
      await click('Edit', 'Find…')
      await expect(page.getByLabel('Find text')).toBeFocused()
    } finally {
      await app.close()
    }
  })

  test('restores tabs and page after a crash (process killed)', async () => {
    const first = await launch({ files: [fixture('sample.pdf')] })
    await expect(first.page.locator('[data-page="1"] canvas')).toBeVisible()
    await gotoPage(first.page, 3)
    await expect.poll(() => currentPage(first.page)).toBe('3')
    await first.page.waitForTimeout(1500) // debounce + main-side snapshot
    await crash(first.app) // hard crash: no clean-exit flag written

    const second = await launch({ userData: first.userData })
    try {
      await expect(second.page.getByRole('tab', { name: /sample\.pdf/ })).toBeVisible()
      await expect.poll(() => currentPage(second.page)).toBe('3')
    } finally {
      await second.app.close()
    }
  })

  test('restores the last session after a normal quit too, but not when the setting is off', async () => {
    const first = await launch({ files: [fixture('sample.pdf'), fixture('mixed.pdf')] })
    await expect(first.page.getByRole('tab')).toHaveCount(2)
    await first.page.waitForTimeout(1000)
    await first.app.close()

    const second = await launch({ userData: first.userData })
    await expect(second.page.getByRole('tab')).toHaveCount(2)
    await second.page.evaluate(() => window.epdf.setSetting({ key: 'restoreOnLaunch', value: false }))
    await second.app.close()

    const third = await launch({ userData: first.userData })
    try {
      await expect(third.page.getByText('Recent files')).toBeVisible()
      await expect(third.page.getByRole('tab')).toHaveCount(0)
    } finally {
      await third.app.close()
    }
  })

  test('remembers the last page of a file across sessions', async () => {
    const first = await launch({ files: [fixture('sample.pdf')] })
    await expect(first.page.locator('[data-page="1"] canvas')).toBeVisible()
    await gotoPage(first.page, 4)
    await expect.poll(() => currentPage(first.page)).toBe('4')
    await first.page.waitForTimeout(1000)
    await first.app.close()

    const second = await launch({ userData: first.userData, files: [fixture('sample.pdf')] })
    try {
      await expect.poll(() => currentPage(second.page)).toBe('4')
    } finally {
      await second.app.close()
    }
  })

  test('a file that is not a PDF is rejected without opening a tab', async () => {
    const { app, page } = await launch()
    try {
      await app.evaluate(({ dialog }) => {
        ;(dialog as unknown as { showMessageBox: () => Promise<unknown> }).showMessageBox = () =>
          Promise.resolve({ response: 0, checkboxChecked: false })
      })
      const handle = await page.evaluate((p) => window.epdf.openPath(p), fixture('not-a-pdf.pdf'))
      expect(handle).toBeNull()
      await expect(page.getByRole('tab')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('renderer is sandboxed and IPC is validated', async () => {
    const { app, page } = await launch({ files: [fixture('sample.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const env = await page.evaluate(() => ({
        require: typeof (window as unknown as { require?: unknown }).require,
        process: typeof (window as unknown as { process?: unknown }).process,
        ipcRenderer: typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer,
        api: Object.keys(window.epdf).sort()
      }))
      expect(env.require).toBe('undefined')
      expect(env.process).toBe('undefined')
      expect(env.ipcRenderer).toBe('undefined')
      expect(env.api).not.toContain('invoke')
      expect(env.api).not.toContain('send')

      // Bad payloads are rejected by main's schema validation.
      const errors = await page.evaluate(async () => {
        const out: string[] = []
        const bad: [string, () => Promise<unknown>][] = [
          ['bad theme', () => window.epdf.setSetting({ key: 'theme', value: 'evil' } as never)],
          ['bad key', () => window.epdf.setSetting({ key: '__proto__', value: 1 } as never)],
          ['docId type', () => window.epdf.closeDoc(123 as never)],
          ['huge path list', () => window.epdf.openDropped(new Array(500).fill('a.pdf'))]
        ]
        for (const [name, fn] of bad) {
          try {
            await fn()
            out.push(`${name}: accepted`)
          } catch {
            out.push(`${name}: rejected`)
          }
        }
        return out
      })
      expect(errors).toEqual(['bad theme: rejected', 'bad key: rejected', 'docId type: rejected', 'huge path list: rejected'])

      // Only known event channels can be subscribed to.
      await expect(page.evaluate(() => window.epdf.on('evil:channel' as never, () => undefined))).rejects.toThrow()
    } finally {
      await app.close()
    }
  })

  test('strict CSP, no path traversal, and unknown docs are 404', async () => {
    const { app, page } = await launch({ files: [fixture('sample.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const res = await page.evaluate(async () => {
        const html = await fetch(location.href)
        const unknown = await fetch('epdf-app://app/doc/not-a-real-id')
        const traversal = await fetch('epdf-app://app/%2e%2e/%2e%2e/package.json')
        const traversal2 = await fetch('epdf-app://app/assets/..%2f..%2f..%2fpackage.json')
        return {
          csp: html.headers.get('content-security-policy'),
          unknown: unknown.status,
          traversal: (await traversal.text()).includes('"name": "epdf"'),
          traversal2: (await traversal2.text()).includes('"name": "epdf"')
        }
      })
      expect(res.csp).toContain("default-src 'none'")
      expect(res.csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
      expect(res.csp).not.toContain("'unsafe-eval'")
      expect(res.unknown).toBe(404)
      expect(res.traversal).toBe(false)
      expect(res.traversal2).toBe(false)
    } finally {
      await app.close()
    }
  })

  test('PDF bytes are served with range support', async () => {
    const { app, page } = await launch({ files: [fixture('sample.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const r = await page.evaluate(async () => {
        const docId = document.querySelector('[role="tab"]')!.id.replace(/^tab-/, '')
        const res = await fetch(`epdf-app://app/doc/${docId}`, { headers: { Range: 'bytes=0-7' } })
        const buf = new Uint8Array(await res.arrayBuffer())
        return { status: res.status, range: res.headers.get('content-range'), head: String.fromCharCode(...buf) }
      })
      expect(r.status).toBe(206)
      expect(r.range).toMatch(/^bytes 0-7\/\d+$/)
      expect(r.head).toBe('%PDF-1.7')
    } finally {
      await app.close()
    }
  })

  test('follows the OS light/dark theme', async () => {
    const { app, page } = await launch()
    try {
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'dark'
      })
      await expect(page.locator('html')).toHaveClass(/dark/)
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'light'
      })
      await expect(page.locator('html')).not.toHaveClass(/dark/)
    } finally {
      await app.close()
    }
  })

  test('has no WCAG 2.1 A/AA violations (empty state and viewer, light and dark)', async () => {
    const { app, page } = await launch()
    const scan = async (label: string): Promise<void> => {
      expect(await axeViolations(page, label)).toEqual([])
    }
    try {
      await scan('empty light')
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'dark'
      })
      await expect(page.locator('html')).toHaveClass(/dark/)
      await scan('empty dark')

      const child = spawn(electronPath, ['.', fixture('sample.pdf')], {
        env: { ...process.env, EPDF_USER_DATA: await app.evaluate(({ app: a }) => a.getPath('userData')), ELECTRON_RENDERER_URL: '' },
        stdio: 'ignore'
      })
      await new Promise((r) => child.on('exit', r))
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await page.getByRole('button', { name: 'Find in document' }).click()
      await page.getByLabel('Find text').fill('needle')
      await expect(page.getByRole('search').getByRole('status')).toHaveText('1 of 3')
      await scan('viewer dark')
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'light'
      })
      await scan('viewer light')
    } finally {
      await app.close()
    }
  })

  test('drops of PDF paths open as tabs (openDropped path)', async () => {
    const { app, page } = await launch()
    try {
      const handles = await page.evaluate((p) => window.epdf.openDropped([p, 'C:\\nope\\readme.txt']), fixture('mixed.pdf'))
      expect(handles).toHaveLength(1) // non-PDF extension filtered out
      expect(handles[0].name).toBe('mixed.pdf')
    } finally {
      await app.close()
    }
  })
})

