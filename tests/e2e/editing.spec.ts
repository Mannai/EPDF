import { expect, test, type Page } from '@playwright/test'
import { readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { copyFixture, crash, gotoPage, launch, menuClick, quitDiscarding } from './helpers'

const rotationOnDisk = async (path: string, pageIndex = 0): Promise<number> =>
  (await PDFDocument.load(readFileSync(path))).getPage(pageIndex).getRotation().angle

/** Width vs height of a rendered page: portrait letter = 612x792, rotated 90° = landscape. */
const isLandscape = async (page: Page, n = 1): Promise<boolean> => {
  const box = (await page.locator(`[data-page="${n}"]`).boundingBox())!
  return box.width > box.height
}

const dot = (page: Page) => page.getByTestId('unsaved-dot')

test.describe('editing pipeline: undo/redo, save, versions', () => {
  test('edit marks the tab unsaved; undo/redo move through history; save clears it and writes the file', async () => {
    const path = copyFixture('sample.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await expect(dot(page)).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
      await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled()

      await menuClick(app, 'Document', 'Rotate Page Clockwise')
      await expect.poll(() => isLandscape(page)).toBe(true)
      await expect(dot(page)).toBeVisible()
      await expect(page.getByRole('tab', { name: /unsaved changes/ })).toBeVisible()
      await expect(page).toHaveTitle(/^• sample\.pdf/)
      await expect(page.getByRole('button', { name: 'Undo Rotate page clockwise' })).toBeEnabled()
      expect(await rotationOnDisk(path)).toBe(0) // nothing is written until Save

      await page.getByRole('button', { name: /^Undo/ }).click()
      await expect.poll(() => isLandscape(page)).toBe(false)
      await expect(dot(page)).toHaveCount(0) // back at the on-disk state
      await expect(page.getByRole('button', { name: /^Redo/ })).toBeEnabled()

      await page.getByRole('button', { name: /^Redo/ }).click()
      await expect.poll(() => isLandscape(page)).toBe(true)
      await expect(dot(page)).toBeVisible()

      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dot(page)).toHaveCount(0)
      await expect(page).toHaveTitle(/^sample\.pdf/)
      expect(await rotationOnDisk(path)).toBe(90)

      // Our own write must not look like an external change.
      await page.waitForTimeout(1200)
      await expect(page.getByText('changed on disk')).toHaveCount(0)
      // Other pages are untouched and the document still renders.
      await gotoPage(page, 2)
      await expect(page.locator('[data-page="2"] .textLayer')).toContainText('Epdf sample page 2')
      expect(await rotationOnDisk(path, 1)).toBe(0)
    } finally {
      await app.close()
    }
  })

  test('undoing to the saved state is clean, and a new edit after undo is not mistaken for saved', async () => {
    const path = copyFixture('sample.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Document', 'Rotate Page Clockwise') // 90
      await menuClick(app, 'Document', 'Rotate Page Clockwise') // 180
      await expect.poll(() => page.getByRole('button', { name: /^Undo/ }).isEnabled()).toBe(true)
      await page.getByRole('button', { name: 'Save', exact: true }).click() // saved at 180
      await expect(dot(page)).toHaveCount(0)
      await page.getByRole('button', { name: /^Undo/ }).click() // 90: differs from disk
      await expect(dot(page)).toBeVisible()
      await menuClick(app, 'Document', 'Rotate Page Counterclockwise') // new edit → 0, still differs from disk (180)
      await expect(dot(page)).toBeVisible()
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dot(page)).toHaveCount(0)
      expect(await rotationOnDisk(path)).toBe(0)
    } finally {
      await app.close()
    }
  })

  test('version history keeps the file as it was before each save and restores it as an undoable edit', async () => {
    const path = copyFixture('sample.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'File', 'Version History…')
      await expect(page.getByText('No earlier versions yet')).toBeVisible()
      await page.getByRole('button', { name: 'Close' }).click()

      await menuClick(app, 'Document', 'Rotate Page Clockwise')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dot(page)).toHaveCount(0)
      expect(await rotationOnDisk(path)).toBe(90)

      await menuClick(app, 'File', 'Version History…')
      const dialog = page.getByRole('dialog', { name: 'Version history' })
      await expect(dialog.getByRole('button', { name: 'Restore' })).toHaveCount(1)
      await dialog.getByRole('button', { name: 'Restore' }).click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(() => isLandscape(page)).toBe(false) // the original, portrait version
      await expect(dot(page)).toBeVisible() // restoring is an unsaved change...
      expect(await rotationOnDisk(path)).toBe(90) // ...the file itself is untouched
      await page.getByRole('button', { name: /^Undo/ }).click() // ...and undoable
      await expect.poll(() => isLandscape(page)).toBe(true)
    } finally {
      await app.close()
    }
  })

  test('Save As writes a new file, rebinds the tab to it and leaves the original alone', async () => {
    const path = copyFixture('sample.pdf')
    const target = copyFixture('mixed.pdf', 'saved-as.pdf') // any writable path; will be overwritten
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await app.evaluate(({ dialog }, p) => {
        ;(dialog as unknown as { showSaveDialog: () => Promise<unknown> }).showSaveDialog = () => Promise.resolve({ canceled: false, filePath: p })
      }, target)
      await menuClick(app, 'Document', 'Rotate Page Clockwise')
      await menuClick(app, 'File', 'Save As…')
      await expect(page.getByRole('tab', { name: /saved-as\.pdf/ })).toBeVisible()
      await expect(dot(page)).toHaveCount(0)
      expect(await rotationOnDisk(target)).toBe(90)
      expect((await PDFDocument.load(readFileSync(target))).getPageCount()).toBe(5)
      expect(await rotationOnDisk(path)).toBe(0)

      // The tab now saves to the new file.
      await menuClick(app, 'Document', 'Rotate Page Clockwise')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dot(page)).toHaveCount(0)
      expect(await rotationOnDisk(target)).toBe(180)
      expect(await rotationOnDisk(path)).toBe(0)
    } finally {
      await app.close()
    }
  })

  test('Save a Copy writes elsewhere and keeps the tab unsaved', async () => {
    const path = copyFixture('sample.pdf')
    const copy = copyFixture('mixed.pdf', 'copy.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await app.evaluate(({ dialog }, p) => {
        ;(dialog as unknown as { showSaveDialog: () => Promise<unknown> }).showSaveDialog = () => Promise.resolve({ canceled: false, filePath: p })
      }, copy)
      await menuClick(app, 'Document', 'Rotate Page Clockwise')
      await menuClick(app, 'File', 'Save a Copy…')
      await expect(page.getByText('Saved a copy as “copy.pdf”')).toBeVisible()
      expect(await rotationOnDisk(copy)).toBe(90)
      expect(await rotationOnDisk(path)).toBe(0)
      await expect(page.getByRole('tab', { name: /sample\.pdf/ })).toBeVisible()
      await expect(dot(page)).toBeVisible()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('a failed save reports the error and keeps the edits', async () => {
    const path = copyFixture('sample.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Document', 'Rotate Page Clockwise')
      await expect(dot(page)).toBeVisible()
      // Make the write impossible portably: delete the (test-owned) temp folder holding the file.
      rmSync(dirname(path), { recursive: true, force: true })
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByRole('alert').filter({ hasText: /Couldn’t save/ })).toBeVisible()
      await expect(dot(page)).toBeVisible() // still unsaved
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

test.describe('unsaved-changes safety', () => {
  test('closing a dirty tab asks first: Cancel keeps it, Don’t Save discards, Save writes', async () => {
    const path = copyFixture('sample.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Document', 'Rotate Page Clockwise')
      await expect(dot(page)).toBeVisible()

      await page.locator('[data-close="sample.pdf"]').click()
      const dlg = page.getByRole('dialog', { name: /Save changes to “sample\.pdf”\?/ })
      await expect(dlg).toBeVisible()
      await dlg.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByRole('tab', { name: /sample\.pdf/ })).toBeVisible()
      await expect(dot(page)).toBeVisible()

      // Escape means Cancel too.
      await page.locator('[data-close="sample.pdf"]').click()
      await expect(dlg).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(dlg).toHaveCount(0)
      await expect(page.getByRole('tab')).toHaveCount(1)

      await page.locator('[data-close="sample.pdf"]').click()
      await dlg.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByRole('tab')).toHaveCount(0)
      expect(await rotationOnDisk(path)).toBe(90)
    } finally {
      await app.close()
    }
  })

  test('Don’t Save closes without writing anything', async () => {
    const path = copyFixture('sample.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Document', 'Rotate Page Clockwise')
      await page.getByRole('tab', { name: /sample\.pdf/ }).focus()
      await page.keyboard.press('Delete')
      await page.getByRole('dialog').getByRole('button', { name: 'Don’t Save' }).click()
      await expect(page.getByRole('tab')).toHaveCount(0)
      expect(await rotationOnDisk(path)).toBe(0)
    } finally {
      await app.close()
    }
  })

  test('closing a window with unsaved edits is vetoed until the user decides', async () => {
    const path = copyFixture('sample.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Document', 'Rotate Page Clockwise')
      await expect(dot(page)).toBeVisible()
      await page.waitForTimeout(300) // let the dirty flag reach main

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
      const dlg = page.getByRole('dialog', { name: /Save changes to “sample\.pdf”\?/ })
      await expect(dlg).toBeVisible()
      expect(page.isClosed()).toBe(false)

      await dlg.getByRole('button', { name: 'Cancel' }).click()
      await expect(dlg).toHaveCount(0)
      expect(page.isClosed()).toBe(false)

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
      await expect(dlg).toBeVisible()
      const closed = page.waitForEvent('close')
      await dlg.getByRole('button', { name: 'Save', exact: true }).click()
      await closed
      expect(await rotationOnDisk(path)).toBe(90)
    } finally {
      await app.close().catch(() => undefined)
    }
  })

  test('quitting with unsaved edits asks first; Cancel keeps the app running, Don’t Save quits and discards', async () => {
    const path = copyFixture('sample.pdf')
    const { app, page, userData } = await launch({ files: [path], env: { EPDF_AUTOSAVE_MS: '300' } })
    const exited = new Promise<void>((r) => app.process().once('exit', () => r()))
    await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
    await menuClick(app, 'Document', 'Rotate Page Clockwise')
    await expect(dot(page)).toBeVisible()
    await page.waitForTimeout(800) // autosaved to the recovery folder

    await app.evaluate(({ app: a }) => a.quit())
    const dlg = page.getByRole('dialog', { name: /Save changes to “sample\.pdf”\?/ })
    await expect(dlg).toBeVisible()
    await dlg.getByRole('button', { name: 'Cancel' }).click()
    await expect(dlg).toHaveCount(0)
    expect(await app.evaluate(({ app: a }) => a.isReady())).toBe(true) // still running
    await expect(dot(page)).toBeVisible() // edits intact

    await app.evaluate(({ app: a }) => a.quit())
    await expect(dlg).toBeVisible()
    await dlg.getByRole('button', { name: 'Don’t Save' }).click()
    await exited
    expect(await rotationOnDisk(path)).toBe(0)

    // Discarding also removed the autosaved copy: the next launch has nothing to recover.
    const again = await launch({ userData })
    try {
      await expect(again.page.getByRole('tab', { name: /sample\.pdf/ })).toBeVisible()
      await again.page.waitForTimeout(800)
      await expect(again.page.getByRole('dialog')).toHaveCount(0)
      await expect.poll(() => isLandscape(again.page)).toBe(false)
    } finally {
      await again.app.close()
    }
  })

  test('quitting with several clean windows closes them all and restores them next time', async () => {
    const first = await launch({ files: [copyFixture('sample.pdf'), copyFixture('mixed.pdf')] })
    await expect(first.page.getByRole('tab')).toHaveCount(2)
    await menuClick(first.app, 'Document', 'Move Tab to New Window')
    await expect.poll(() => first.app.windows().length).toBe(2)
    await menuClick(first.app, 'File', 'New Window') // plus an empty third window
    await expect.poll(() => first.app.windows().length).toBe(3)
    await first.page.waitForTimeout(1000)
    await first.app.close() // must complete: every window answers "nothing unsaved" and the quit resumes

    const second = await launch({ userData: first.userData })
    try {
      // The two windows that had documents are restored; the empty one is not.
      await expect.poll(() => second.app.windows().length).toBe(2)
      for (const w of second.app.windows()) await expect(w.getByRole('tab')).toHaveCount(1)
    } finally {
      await second.app.close()
    }
  })

  test('a window whose page is frozen still closes (it can never get stuck)', async () => {
    const { app, page } = await launch({ files: [copyFixture('sample.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      // Hang the renderer's main thread for longer than main's acknowledgement watchdog.
      void page.evaluate(() => {
        const end = Date.now() + 9000
        while (Date.now() < end) {
          /* spin */
        }
      }).catch(() => undefined)
      await new Promise((r) => setTimeout(r, 300))
      const t0 = Date.now()
      const closed = page.waitForEvent('close', { timeout: 7000 })
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
      await closed
      expect(Date.now() - t0).toBeLessThan(6000)
    } finally {
      await app.close().catch(() => undefined)
    }
  })

  test('repeated close attempts while the prompt is open show one prompt and never wedge the window', async () => {
    const { app, page } = await launch({ files: [copyFixture('sample.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Document', 'Rotate Page Clockwise')
      await expect(dot(page)).toBeVisible()
      for (let i = 0; i < 4; i++) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
      const dlg = page.getByRole('dialog', { name: /Save changes to “sample\.pdf”\?/ })
      await expect(dlg).toBeVisible()
      await page.waitForTimeout(3500) // longer than the watchdog: an acknowledged prompt must NOT be force-closed
      await expect(dlg).toHaveCount(1)
      expect(page.isClosed()).toBe(false)

      await dlg.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0) // exactly one prompt was queued, none left over
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
      await expect(dlg).toBeVisible() // and the window can be asked again
      const closed = page.waitForEvent('close')
      await dlg.getByRole('button', { name: 'Don’t Save' }).click()
      await closed
    } finally {
      await app.close().catch(() => undefined)
    }
  })

  test('a window with no unsaved edits closes immediately', async () => {
    const { app, page } = await launch({ files: [copyFixture('sample.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const closed = page.waitForEvent('close')
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
      await closed
    } finally {
      await app.close().catch(() => undefined)
    }
  })
})

test.describe('autosave and crash recovery of unsaved edits', () => {
  test('edits made before a crash are offered back and can be recovered', async () => {
    const path = copyFixture('sample.pdf')
    const first = await launch({ files: [path], env: { EPDF_AUTOSAVE_MS: '300' } })
    await expect(first.page.locator('[data-page="1"] canvas')).toBeVisible()
    await menuClick(first.app, 'Document', 'Rotate Page Clockwise')
    await expect(dot(first.page)).toBeVisible()
    await first.page.waitForTimeout(1500) // autosave + session snapshot
    await crash(first.app)
    expect(await rotationOnDisk(path)).toBe(0) // the file itself was never touched

    const second = await launch({ userData: first.userData, env: { EPDF_AUTOSAVE_MS: '300' } })
    try {
      const dlg = second.page.getByRole('dialog', { name: /Recover unsaved changes to “sample\.pdf”\?/ })
      await expect(dlg).toBeVisible()
      await dlg.getByRole('button', { name: 'Recover' }).click()
      await expect.poll(() => isLandscape(second.page)).toBe(true)
      await expect(dot(second.page)).toBeVisible()
      // Saving the recovered edits writes them for real.
      await second.page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dot(second.page)).toHaveCount(0)
      expect(await rotationOnDisk(path)).toBe(90)
    } finally {
      await second.app.close()
    }
  })

  test('declining recovery discards the autosaved copy for good', async () => {
    const path = copyFixture('sample.pdf')
    const first = await launch({ files: [path], env: { EPDF_AUTOSAVE_MS: '300' } })
    await expect(first.page.locator('[data-page="1"] canvas')).toBeVisible()
    await menuClick(first.app, 'Document', 'Rotate Page Clockwise')
    await first.page.waitForTimeout(1500)
    await crash(first.app)

    const second = await launch({ userData: first.userData })
    await second.page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click()
    await expect(second.page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => isLandscape(second.page)).toBe(false)
    await expect(dot(second.page)).toHaveCount(0)
    await second.app.close()

    // Third launch: nothing left to recover.
    const third = await launch({ userData: first.userData })
    try {
      await expect(third.page.getByRole('tab', { name: /sample\.pdf/ })).toBeVisible()
      await third.page.waitForTimeout(800)
      await expect(third.page.getByRole('dialog')).toHaveCount(0)
    } finally {
      await third.app.close()
    }
  })

  test('undoing back to the saved state removes the stale recovery copy', async () => {
    const path = copyFixture('sample.pdf')
    const first = await launch({ files: [path], env: { EPDF_AUTOSAVE_MS: '300' } })
    await expect(first.page.locator('[data-page="1"] canvas')).toBeVisible()
    await menuClick(first.app, 'Document', 'Rotate Page Clockwise')
    await first.page.waitForTimeout(1200) // autosaved
    await first.page.getByRole('button', { name: /^Undo/ }).click()
    await expect(dot(first.page)).toHaveCount(0)
    await first.page.waitForTimeout(1200) // stale recovery cleared
    await crash(first.app)

    const second = await launch({ userData: first.userData })
    try {
      await expect(second.page.getByRole('tab', { name: /sample\.pdf/ })).toBeVisible()
      await second.page.waitForTimeout(800)
      await expect(second.page.getByRole('dialog')).toHaveCount(0)
    } finally {
      await second.app.close()
    }
  })

  test('moving a tab with unsaved edits to a new window carries the edits along', async () => {
    const { app, page } = await launch({ files: [copyFixture('sample.pdf')] })
    let second: Page = page
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Document', 'Rotate Page Clockwise')
      await expect(dot(page)).toBeVisible()
      await menuClick(app, 'Document', 'Move Tab to New Window')
      await expect.poll(() => app.windows().length).toBe(2)
      second = app.windows().find((w) => w !== page)!
      await expect(second.getByRole('tab', { name: /sample\.pdf/ })).toBeVisible()
      await expect.poll(() => isLandscape(second)).toBe(true)
      await expect(second.getByTestId('unsaved-dot')).toBeVisible()
      await expect(second.getByRole('dialog')).toHaveCount(0) // no prompt: it was a move, not a crash
    } finally {
      await quitDiscarding(app, second)
    }
  })
})

test.describe('background jobs', () => {
  test('a worker-thread job reports progress and completes', async () => {
    const { app, page } = await launch()
    try {
      const jobId = await page.evaluate(async () => (await window.epdf.call<{ jobId: string }>('job:start', { kind: 'selftest:count', payload: { steps: 6, delayMs: 60 } })).jobId)
      expect(jobId).toMatch(/^[0-9a-f-]{36}$/)
      const card = page.locator('[data-job="selftest:count"]')
      await expect(card).toContainText('Self-test')
      await expect(card.getByRole('progressbar')).toBeVisible()
      await expect(card).toContainText('Finished')
    } finally {
      await app.close()
    }
  })

  test('a long job can be cancelled from the tray, and the UI stays responsive meanwhile', async () => {
    const { app, page } = await launch()
    try {
      await page.evaluate(() => void window.epdf.call('job:start', { kind: 'selftest:count', payload: { steps: 1000, delayMs: 50 } }))
      const card = page.locator('[data-job="selftest:count"]')
      await expect(card.getByRole('progressbar')).toBeVisible()
      // The renderer is not blocked: measure event-loop latency while the worker runs.
      const lag = await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const t0 = performance.now()
            setTimeout(() => resolve(performance.now() - t0), 50)
          })
      )
      expect(lag).toBeLessThan(500)
      await card.getByRole('button', { name: 'Cancel' }).click()
      await expect(card).toContainText('Cancelled')
    } finally {
      await app.close()
    }
  })

  test('invalid job requests and unknown channels are rejected', async () => {
    const { app, page } = await launch()
    try {
      const results = await page.evaluate(async () => {
        const attempts: [string, () => Promise<unknown>][] = [
          ['unknown kind', () => window.epdf.call('job:start', { kind: 'nope:nope', payload: {} })],
          ['bad payload', () => window.epdf.call('job:start', { kind: 'selftest:count', payload: { steps: -1, delayMs: 0 } })],
          ['unregistered channel', () => window.epdf.call('fs:readFile', { path: 'C:\\Windows\\win.ini' })],
          ['bad channel name', () => window.epdf.call('not a channel', {})]
        ]
        const out: string[] = []
        for (const [name, fn] of attempts) {
          try {
            await fn()
            out.push(`${name}: accepted`)
          } catch {
            out.push(`${name}: rejected`)
          }
        }
        return out
      })
      expect(results).toEqual(['unknown kind: rejected', 'bad payload: rejected', 'unregistered channel: rejected', 'bad channel name: rejected'])
    } finally {
      await app.close()
    }
  })
})
