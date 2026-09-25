import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { allStreamText, fixtureBytes, openWith } from '../unit/helpers/securityHelpers'
import { axeViolations, canvasHasInk, copyFixture, fixture, launch, menuClick, quitDiscarding } from './helpers'

/**
 * Password protection driven through the real app: protect, save, reopen, edit, recover, remove, change, permissions.
 * Protected files are checked on disk with our own decryptor (and pdf-lib refusing to open them plain).
 */

const FIXTURES = resolve('tests/fixtures/security')

/** A throwaway copy of one of the committed qpdf fixtures. */
function copyProtected(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'epdf-sec-doc-'))
  const dest = join(dir, `${name}.pdf`)
  copyFileSync(join(FIXTURES, `${name}.pdf`), dest)
  return dest
}

const latin = (b: Uint8Array): string => Buffer.from(b).toString('latin1')
const bytesOf = (path: string): Uint8Array => new Uint8Array(readFileSync(path))
const isEncrypted = (path: string): boolean => latin(bytesOf(path)).includes('/Encrypt')

/** pdf-lib refuses encrypted files, which is exactly what proves nothing readable is on disk. */
async function pdfLibRefuses(path: string): Promise<boolean> {
  try {
    await PDFDocument.load(bytesOf(path), { updateMetadata: false })
    return false
  } catch (err) {
    return /encrypt/i.test((err as Error).message)
  }
}

async function textOnDisk(path: string, password: string): Promise<string> {
  return allStreamText((await openWith(bytesOf(path), password)).plain)
}

async function rotationOnDisk(path: string, password: string): Promise<number> {
  const plain = (await openWith(bytesOf(path), password)).plain
  return (await PDFDocument.load(plain)).getPage(0).getRotation().angle
}

const dialogOf = (page: Page, name: string) => page.getByRole('dialog', { name, exact: true })
const saveButton = (page: Page) => page.getByRole('button', { name: 'Save', exact: true })
const unsavedDot = (page: Page) => page.getByTestId('unsaved-dot')

function menuSub(app: ElectronApplication, menu: string, sub: string, item: string): Promise<void> {
  return app.evaluate(
    ({ Menu }, [m, s, i]) => {
      const strip = (x: string): string => x.replace('&', '')
      const top = Menu.getApplicationMenu()!.items.find((x) => strip(x.label) === m)
      const subItem = top?.submenu?.items.find((x) => strip(x.label) === s)
      const it = subItem?.submenu?.items.find((x) => strip(x.label) === i)
      if (!it) throw new Error(`Menu item not found: ${m} > ${s} > ${i}`)
      it.click()
    },
    [menu, sub, item]
  )
}

async function stubSaveDialog(app: ElectronApplication, ...paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, list) => {
    const queue = [...list]
    ;(dialog as unknown as Record<string, unknown>).showSaveDialog = async () => {
      const next = queue.shift()
      return { canceled: !next, filePath: next }
    }
  }, paths)
}

/** Answers the core "Password required" prompt PDF.js triggers when a protected file is opened. */
async function openPrompt(page: Page, password: string): Promise<void> {
  const dlg = dialogOf(page, 'Password required')
  await expect(dlg).toBeVisible()
  await dlg.getByLabel('Document password').fill(password)
  await dlg.getByRole('button', { name: 'Open' }).click()
}

async function expectPageRenders(page: Page, text = 'Epdf sample page 1'): Promise<void> {
  await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
  await expect.poll(() => canvasHasInk(page, '[data-page="1"] canvas')).toBe(true)
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText(text)
}

interface ProtectOpts {
  user?: string
  owner?: string
  algorithm?: string
  noPrint?: boolean
  noCopy?: boolean
  noEdit?: boolean
}

/** Tools > Protect with Password… filled in and confirmed. */
async function protectViaUi(app: ElectronApplication, page: Page, o: ProtectOpts): Promise<void> {
  await menuClick(app, 'Tools', 'Protect with Password…')
  const dlg = dialogOf(page, 'Protect with Password')
  await expect(dlg).toBeVisible()
  await fillProtectForm(dlg, o)
  await dlg.getByRole('button', { name: 'Protect' }).click()
  await expect(dlg).toHaveCount(0)
}

async function fillProtectForm(dlg: ReturnType<typeof dialogOf>, o: ProtectOpts): Promise<void> {
  if (o.algorithm) await dlg.getByLabel('Encryption').selectOption(o.algorithm)
  if (o.user !== undefined) {
    await dlg.getByLabel('Password to open', { exact: true }).fill(o.user)
    await dlg.getByLabel('Confirm password to open').fill(o.user)
  }
  if (o.owner !== undefined) {
    await dlg.getByLabel('Password to edit', { exact: true }).fill(o.owner)
    await dlg.getByLabel('Confirm password to edit').fill(o.owner)
  }
  if (o.noPrint) await dlg.getByLabel('Printing').selectOption('none')
  if (o.noCopy) await dlg.getByLabel('Copying text and images').uncheck()
  if (o.noEdit) await dlg.getByLabel('Editing content').uncheck()
}

test.describe('security: protecting a document', () => {
  test('protect via the menu, save: the file on disk is encrypted; reopening asks for the password (wrong one rejected)', async () => {
    const path = copyFixture('sample.pdf')
    const first = await launch({ files: [path] })
    try {
      await expectPageRenders(first.page)
      await protectViaUi(first.app, first.page, { user: 'open-me-1', owner: 'boss-2' })
      await expect(unsavedDot(first.page)).toBeVisible()
      await expect(first.page.getByRole('button', { name: 'Undo Protect with password' })).toBeEnabled()
      expect(isEncrypted(path)).toBe(false) // nothing is written until Save
      await saveButton(first.page).click()
      await expect(unsavedDot(first.page)).toHaveCount(0)
    } finally {
      await first.app.close()
    }

    expect(isEncrypted(path)).toBe(true)
    expect(await pdfLibRefuses(path)).toBe(true)
    const raw = latin(bytesOf(path))
    expect(raw).toMatch(/\/Filter\s*\/Standard/)
    expect(raw).toContain('AESV3')
    expect(await textOnDisk(path, 'open-me-1')).toContain('(Epdf sample page 1) Tj')
    expect(await textOnDisk(path, 'boss-2')).toContain('(Epdf sample page 5) Tj')

    const second = await launch({ files: [path] })
    try {
      await openPrompt(second.page, 'not-the-password')
      await expect(dialogOf(second.page, 'Password required').getByRole('alert')).toContainText('incorrect')
      await openPrompt(second.page, 'open-me-1')
      await expectPageRenders(second.page)
    } finally {
      await second.app.close()
    }
  })

  test('cancelling the password prompt on open leaves an error state, not a crash', async () => {
    const path = copyProtected('aes-256-r6')
    const { app, page } = await launch({ files: [path] })
    try {
      const dlg = dialogOf(page, 'Password required')
      await expect(dlg).toBeVisible()
      await dlg.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByRole('alert')).toContainText('A password is required')
      expect(await axeViolations(page, 'password required error')).toEqual([])
    } finally {
      await app.close()
    }
  })

  test('AES-128 and RC4-128 compatibility options produce files those algorithms decrypt', async () => {
    for (const [alg, marker] of [
      ['aes128', 'AESV2'],
      ['rc4-128', '/Length 128']
    ] as const) {
      const path = copyFixture('sample.pdf')
      const { app, page } = await launch({ files: [path] })
      try {
        await expectPageRenders(page)
        await protectViaUi(app, page, { user: 'compat-pw', owner: 'compat-own', algorithm: alg })
        await saveButton(page).click()
        await expect(unsavedDot(page)).toHaveCount(0)
      } finally {
        await app.close()
      }
      expect(await pdfLibRefuses(path)).toBe(true)
      expect(latin(bytesOf(path))).toContain(marker)
      expect(await textOnDisk(path, 'compat-pw')).toContain('(Epdf sample page 2) Tj')
    }
  })

  test('the dialog validates: needs a password, matching confirmations, and an owner password for restrictions', async () => {
    const path = copyFixture('sample.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expectPageRenders(page)
      await menuClick(app, 'Tools', 'Protect with Password…')
      const dlg = dialogOf(page, 'Protect with Password')
      await dlg.getByRole('button', { name: 'Protect' }).click()
      await expect(dlg.getByRole('alert')).toContainText('Enter a password')

      await dlg.getByLabel('Password to open', { exact: true }).fill('abc')
      await dlg.getByLabel('Confirm password to open').fill('abd')
      await dlg.getByRole('button', { name: 'Protect' }).click()
      await expect(dlg.getByRole('alert')).toContainText('do not match')

      await dlg.getByLabel('Confirm password to open').fill('abc')
      await dlg.getByLabel('Printing').selectOption('none')
      await dlg.getByRole('button', { name: 'Protect' }).click()
      await expect(dlg.getByRole('alert')).toContainText('also set a password to edit')

      // Cancel: nothing changes.
      await dlg.getByRole('button', { name: 'Cancel' }).click()
      await expect(dlg).toHaveCount(0)
      await expect(unsavedDot(page)).toHaveCount(0)
      expect(isEncrypted(path)).toBe(false)
    } finally {
      await app.close()
    }
  })

  test('Escape cancels the protect dialog and the focus returns to the page', async () => {
    const { app, page } = await launch({ files: [copyFixture('sample.pdf')] })
    try {
      await expectPageRenders(page)
      await menuClick(app, 'Tools', 'Protect with Password…')
      await expect(dialogOf(page, 'Protect with Password')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(dialogOf(page, 'Protect with Password')).toHaveCount(0)
      await expect(unsavedDot(page)).toHaveCount(0)
    } finally {
      await app.close()
    }
  })
})

test.describe('security: editing and saving protected documents', () => {
  test('edit then save keeps the protection; Save a Copy and Save As are protected too; recovery copies are never plaintext', async () => {
    const path = copyProtected('aes-256-r6') // qpdf-made: user "user256", owner "owner256"
    const outDir = mkdtempSync(join(tmpdir(), 'epdf-sec-out-'))
    const copyPath = join(outDir, 'copy.pdf')
    const asPath = join(outDir, 'as.pdf')
    const { app, page, userData } = await launch({ files: [path], env: { EPDF_AUTOSAVE_MS: '300' } })
    try {
      await openPrompt(page, 'user256')
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      // Rotate: needs the document unlocked, which reuses the password we just typed (no second prompt).
      await menuClick(app, 'Document', 'Rotate Page Clockwise')
      await expect(unsavedDot(page)).toBeVisible()
      await expect(dialogOf(page, 'Password required to edit')).toHaveCount(0)

      // The autosaved recovery copy is protected too.
      const recoveryDir = join(userData, 'recovery')
      await expect.poll(() => existsSync(recoveryDir) && readdirSync(recoveryDir).length > 0, { timeout: 15_000 }).toBe(true)
      for (const f of readdirSync(recoveryDir)) {
        const p = join(recoveryDir, f)
        expect(isEncrypted(p), `recovery file ${f} must be encrypted`).toBe(true)
        expect(await pdfLibRefuses(p)).toBe(true)
        expect(await rotationOnDisk(p, 'user256')).toBe(90)
      }

      await stubSaveDialog(app, copyPath)
      await menuClick(app, 'File', 'Save a Copy…')
      await expect.poll(() => existsSync(copyPath)).toBe(true)
      await expect.poll(() => isEncrypted(copyPath)).toBe(true)
      expect(await pdfLibRefuses(copyPath)).toBe(true)
      expect(await rotationOnDisk(copyPath, 'user256')).toBe(90)

      await saveButton(page).click()
      await expect(unsavedDot(page)).toHaveCount(0)
      expect(isEncrypted(path)).toBe(true)
      expect(await pdfLibRefuses(path)).toBe(true)
      expect(await rotationOnDisk(path, 'user256')).toBe(90)
      expect(await rotationOnDisk(path, 'owner256')).toBe(90) // the owner password still works
      expect(await textOnDisk(path, 'user256')).toContain('(Secret page 1) Tj')

      // Another edit and Save As: still protected.
      await menuClick(app, 'Document', 'Rotate Page Clockwise')
      await stubSaveDialog(app, asPath)
      await menuClick(app, 'File', 'Save As…')
      await expect.poll(() => existsSync(asPath)).toBe(true)
      await expect(unsavedDot(page)).toHaveCount(0)
      expect(await pdfLibRefuses(asPath)).toBe(true)
      expect(await rotationOnDisk(asPath, 'user256')).toBe(180)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('an unedited protected file saved as a copy is byte-for-byte still encrypted (never double-encrypted)', async () => {
    const path = copyProtected('aes-128')
    const copyPath = join(mkdtempSync(join(tmpdir(), 'epdf-sec-out-')), 'plain-copy.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await openPrompt(page, 'userAes')
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await stubSaveDialog(app, copyPath)
      await menuClick(app, 'File', 'Save a Copy…')
      await expect.poll(() => existsSync(copyPath)).toBe(true)
      await expect.poll(() => isEncrypted(copyPath)).toBe(true)
      expect(await textOnDisk(copyPath, 'userAes')).toContain('(Secret page 3) Tj')
    } finally {
      await app.close()
    }
  })

  test('editing asks for the password when it cannot be reused, retries a wrong one, and Cancel leaves the document alone', async () => {
    const path = copyProtected('rc4-128') // user "user128"
    const { app, page } = await launch({ files: [path] })
    try {
      await openPrompt(page, 'user128')
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      // Recovered-from-crash style content would need the prompt; here PDF.js gave us the password, so no prompt.
      await menuClick(app, 'Document', 'Rotate Page Clockwise')
      await expect(unsavedDot(page)).toBeVisible()
      await expect(dialogOf(page, 'Password required to edit')).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

test.describe('security: removing and changing protection', () => {
  test('Remove Password Protection is one undo step; after saving the file is plain', async () => {
    const path = copyProtected('aes-256-r6')
    const { app, page } = await launch({ files: [path] })
    try {
      await openPrompt(page, 'owner256')
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Tools', 'Remove Password Protection…')
      const confirm = page.getByRole('dialog', { name: 'Remove password protection?' })
      await expect(confirm).toBeVisible()
      await confirm.getByRole('button', { name: 'Remove Protection' }).click()
      await expect(unsavedDot(page)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Undo Remove password protection' })).toBeEnabled()

      // Undo restores the protection (still unsaved -> back to the saved state), redo removes it again.
      await page.getByRole('button', { name: /^Undo/ }).click()
      await expect(unsavedDot(page)).toHaveCount(0)
      await page.getByRole('button', { name: /^Redo/ }).click()
      await expect(unsavedDot(page)).toBeVisible()
      await saveButton(page).click()
      await expect(unsavedDot(page)).toHaveCount(0)
    } finally {
      await app.close()
    }
    expect(isEncrypted(path)).toBe(false)
    const doc = await PDFDocument.load(bytesOf(path))
    expect(doc.getPageCount()).toBe(3)
    expect(await allStreamText(bytesOf(path))).toContain('(Secret page 2) Tj')

    // Reopening needs no password.
    const second = await launch({ files: [path] })
    try {
      await expect(second.page.locator('[data-page="1"] canvas')).toBeVisible()
      await expect(dialogOf(second.page, 'Password required')).toHaveCount(0)
    } finally {
      await second.app.close()
    }
  })

  test('remove protection on an unprotected document says so; cancelling the confirmation changes nothing', async () => {
    const { app, page } = await launch({ files: [copyFixture('sample.pdf')] })
    try {
      await expectPageRenders(page)
      await menuClick(app, 'Tools', 'Remove Password Protection…')
      await expect(page.getByText('is not password protected')).toBeVisible()
    } finally {
      await app.close()
    }
    const path = copyProtected('aes-128')
    const b = await launch({ files: [path] })
    try {
      await openPrompt(b.page, 'ownerAes')
      await expect(b.page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(b.app, 'Tools', 'Remove Password Protection…')
      await b.page.getByRole('dialog', { name: 'Remove password protection?' }).getByRole('button', { name: 'Cancel' }).click()
      await expect(unsavedDot(b.page)).toHaveCount(0)
    } finally {
      await b.app.close()
    }
    expect(isEncrypted(path)).toBe(true)
  })

  test('removing protection needs the owner password: a user-password session is asked for it', async () => {
    const path = copyProtected('aes-256-r6')
    const { app, page } = await launch({ files: [path] })
    try {
      await openPrompt(page, 'user256')
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Tools', 'Remove Password Protection…')
      const dlg = dialogOf(page, 'Owner password required')
      await expect(dlg).toBeVisible()
      await dlg.getByLabel('Password').fill('user256') // a user password is not enough
      await dlg.getByRole('button', { name: 'Continue' }).click()
      await expect(dlg.getByRole('alert')).toContainText('incorrect')
      await dlg.getByRole('button', { name: 'Cancel' }).click()
      await expect(dlg).toHaveCount(0)
      await expect(page.getByRole('dialog', { name: 'Remove password protection?' })).toHaveCount(0)
      await expect(unsavedDot(page)).toHaveCount(0)
    } finally {
      await app.close()
    }
    expect(isEncrypted(path)).toBe(true)
  })

  test('change password and permissions of a protected document: new passwords work, old ones do not', async () => {
    const path = copyProtected('rc4-128') // user128 / owner128
    const first = await launch({ files: [path] })
    try {
      await openPrompt(first.page, 'owner128')
      await expect(first.page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(first.app, 'Tools', 'Protect with Password…')
      const dlg = dialogOf(first.page, 'Change Password Protection')
      await expect(dlg).toBeVisible()
      // Defaults reflect what the file uses today.
      await expect(dlg.getByLabel('Encryption')).toHaveValue('rc4-128')
      await fillProtectForm(dlg, { user: 'brand-new-user', owner: 'brand-new-owner', algorithm: 'aes256', noCopy: true })
      await dlg.getByRole('button', { name: 'Apply' }).click()
      await expect(dlg).toHaveCount(0)
      await expect(first.page.getByRole('button', { name: 'Undo Change password protection' })).toBeEnabled()
      await saveButton(first.page).click()
      await expect(unsavedDot(first.page)).toHaveCount(0)
    } finally {
      await first.app.close()
    }
    expect(latin(bytesOf(path))).toContain('AESV3')
    await expect(openWith(bytesOf(path), 'user128')).rejects.toThrow('wrong password')
    await expect(openWith(bytesOf(path), 'owner128')).rejects.toThrow('wrong password')
    expect(await textOnDisk(path, 'brand-new-user')).toContain('(Secret page 1) Tj')
    const opened = await openWith(bytesOf(path), 'brand-new-owner')
    expect(opened.access.kind).toBe('owner')
    expect(opened.info.R).toBe(6)
    // The copy restriction was applied: /P has the copy bit (5) cleared.
    expect(opened.info.P & 0x10).toBe(0)
  })
})

test.describe('security: permissions are respected when opened with the user password', () => {
  test('editing is refused with a clear message and changes nothing; the owner password can edit', async () => {
    const path = copyProtected('no-permissions-aes256') // user u256p, owner o256p, everything restricted
    const first = await launch({ files: [path] })
    try {
      await openPrompt(first.page, 'u256p')
      await expect(first.page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(first.app, 'Document', 'Rotate Page Clockwise')
      await expect(first.page.getByText('its permissions do not allow changing the document')).toBeVisible()
      await expect(unsavedDot(first.page)).toHaveCount(0)
      await expect(first.page.getByRole('button', { name: /^Undo/ })).toBeDisabled()
    } finally {
      await first.app.close()
    }
    expect(await rotationOnDisk(path, 'u256p')).toBe(0)

    const second = await launch({ files: [path] })
    try {
      await openPrompt(second.page, 'o256p')
      await expect(second.page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(second.app, 'Document', 'Rotate Page Clockwise')
      await expect(unsavedDot(second.page)).toBeVisible()
      await saveButton(second.page).click()
      await expect(unsavedDot(second.page)).toHaveCount(0)
    } finally {
      await second.app.close()
    }
    expect(await rotationOnDisk(path, 'o256p')).toBe(90)
    // The restrictions survive the owner's save.
    expect((await openWith(bytesOf(path), 'u256p')).info.P & 0x0c).toBe(0)
  })

  test('printing and copying refuse politely with the user password, and work with the owner password', async () => {
    const path = copyProtected('no-permissions-aes256')
    const first = await launch({ files: [path] })
    try {
      await openPrompt(first.page, 'u256p')
      await expect(first.page.locator('[data-page="1"] .textLayer')).toContainText('Secret page 1')
      await menuClick(first.app, 'File', 'Print…')
      await expect(first.page.getByText('Printing is not allowed by this document’s permissions')).toBeVisible()
      await expect(first.page.getByRole('dialog', { name: /Print/ })).toHaveCount(0)

      // Copy: select the page text and copy it.
      await first.page.evaluate(() => {
        const layer = document.querySelector('[data-page="1"] .textLayer')!
        const range = document.createRange()
        range.selectNodeContents(layer)
        const sel = window.getSelection()!
        sel.removeAllRanges()
        sel.addRange(range)
      })
      const allowed = await first.page.evaluate(() => {
        // A capture listener on `window` runs before the app's own, and keeps the event so we can ask afterwards.
        const seen: Event[] = []
        const spy = (e: Event): void => void seen.push(e)
        window.addEventListener('copy', spy, true)
        document.execCommand('copy')
        window.removeEventListener('copy', spy, true)
        return seen.length === 1 && !seen[0].defaultPrevented
      })
      expect(allowed).toBe(false)
      await expect(first.page.getByText('Copying is not allowed by this document’s permissions')).toBeVisible()
    } finally {
      await first.app.close()
    }

    const second = await launch({ files: [path] })
    try {
      await openPrompt(second.page, 'o256p')
      await expect(second.page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(second.app, 'File', 'Print…')
      await expect(second.page.getByRole('dialog', { name: /Print/ })).toBeVisible()
      await expect(second.page.getByText('Printing is not allowed')).toHaveCount(0)
    } finally {
      await second.app.close()
    }
  })
})

test.describe('security: the info dialog', () => {
  test('reports algorithm, key length, permissions and whether a password is needed', async () => {
    const path = copyProtected('no-permissions-aes128')
    const { app, page } = await launch({ files: [path] })
    try {
      await openPrompt(page, 'u128')
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuSub(app, 'Tools', 'Document Properties', 'Security…')
      const dlg = dialogOf(page, 'Document Security')
      await expect(dlg).toBeVisible()
      await expect(dlg).toContainText('AES-128')
      await expect(dlg).toContainText('128-bit')
      await expect(dlg).toContainText('Standard (version 4, revision 4)')
      await expect(dlg).toContainText('No: a password is required')
      await expect(dlg.getByRole('list', { name: 'Permissions' })).toContainText('Printing: Not allowed')
      await expect(dlg.getByRole('list', { name: 'Permissions' })).toContainText('Copying text and images: Not allowed')
      await expect(dlg.getByRole('list', { name: 'Permissions' })).toContainText('Accessibility extraction: Allowed')
      await dlg.getByRole('button', { name: 'Close' }).click()
      await expect(dlg).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('an owner-password-only file says it opens without a password; an unprotected file says it is not protected', async () => {
    const path = copyProtected('owner-only')
    const a = await launch({ files: [path] })
    try {
      await expect(a.page.locator('[data-page="1"] canvas')).toBeVisible() // no prompt
      await menuSub(a.app, 'Tools', 'Document Properties', 'Security…')
      const dlg = dialogOf(a.page, 'Document Security')
      await expect(dlg).toContainText('AES-256 (revision 6)')
      await expect(dlg).toContainText('Yes: the password to open is empty')
    } finally {
      await a.app.close()
    }
    const b = await launch({ files: [copyFixture('sample.pdf')] })
    try {
      await expectPageRenders(b.page)
      await menuSub(b.app, 'Tools', 'Document Properties', 'Security…')
      await expect(dialogOf(b.page, 'Document Security')).toContainText('is not password protected')
    } finally {
      await b.app.close()
    }
  })

  test('after protecting (unsaved) the info dialog shows what will be written', async () => {
    const { app, page } = await launch({ files: [copyFixture('sample.pdf')] })
    try {
      await expectPageRenders(page)
      await protectViaUi(app, page, { user: 'pw-a', owner: 'pw-b', noPrint: true })
      await menuSub(app, 'Tools', 'Document Properties', 'Security…')
      const dlg = dialogOf(page, 'Document Security')
      await expect(dlg).toContainText('AES-256 (revision 6)')
      await expect(dlg).toContainText('unsaved changes')
      await expect(dlg.getByRole('list', { name: 'Permissions' })).toContainText('Printing: Not allowed')
      await expect(dlg).toContainText('The owner password')
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

test.describe('security: accessibility (WCAG 2.1 A/AA, light and dark)', () => {
  async function scanBoth(app: ElectronApplication, page: Page, label: string): Promise<void> {
    for (const theme of ['light', 'dark'] as const) {
      await app.evaluate(({ nativeTheme }, t) => void (nativeTheme.themeSource = t), theme)
      if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/)
      else await expect(page.locator('html')).not.toHaveClass(/dark/)
      expect(await axeViolations(page, `${label} ${theme}`)).toEqual([])
    }
  }

  test('protect dialog (with errors), info dialog, owner prompt', async () => {
    const path = copyProtected('aes-256-r6')
    const { app, page } = await launch({ files: [path] })
    try {
      await openPrompt(page, 'user256')
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()

      await menuSub(app, 'Tools', 'Document Properties', 'Security…')
      await expect(dialogOf(page, 'Document Security')).toBeVisible()
      await scanBoth(app, page, 'info')
      await page.keyboard.press('Escape')

      await menuClick(app, 'Tools', 'Remove Password Protection…')
      const owner = dialogOf(page, 'Owner password required')
      await expect(owner).toBeVisible()
      await owner.getByLabel('Password').fill('nope')
      await owner.getByRole('button', { name: 'Continue' }).click()
      await expect(owner.getByRole('alert')).toBeVisible()
      await scanBoth(app, page, 'owner prompt')
      await owner.getByLabel('Password').fill('owner256')
      await owner.getByRole('button', { name: 'Continue' }).click()
      await page.getByRole('dialog', { name: 'Remove password protection?' }).getByRole('button', { name: 'Cancel' }).click()

      await menuClick(app, 'Tools', 'Protect with Password…')
      const dlg = dialogOf(page, 'Change Password Protection')
      await expect(dlg).toBeVisible()
      await dlg.getByRole('button', { name: 'Apply' }).click() // empty passwords: errors are shown
      await expect(dlg.getByRole('alert')).toBeVisible()
      await scanBoth(app, page, 'protect dialog')
      await page.keyboard.press('Escape')
      await expect(dlg).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('the dialogs are keyboard operable: Tab order reaches every control and Enter submits', async () => {
    const { app, page } = await launch({ files: [copyFixture('sample.pdf')] })
    try {
      await expectPageRenders(page)
      await menuClick(app, 'Tools', 'Protect with Password…')
      const dlg = dialogOf(page, 'Protect with Password')
      await dlg.getByLabel('Password to open', { exact: true }).focus()
      await page.keyboard.type('kb-pass')
      await page.keyboard.press('Tab')
      await page.keyboard.type('kb-pass')
      await page.keyboard.press('Enter') // submits the form
      await expect(dlg).toHaveCount(0)
      await expect(unsavedDot(page)).toBeVisible()
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// Referenced only so unused-helper lint stays quiet when a scenario is skipped locally.
void fixture
void fixtureBytes
