import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { MARKER_NEEDLE, embedMarker, hasMarker, makeProtection } from '../../src/renderer/src/features/security/crypto/document'
import { defaultHeaderFooter, defaultWatermark } from '../../src/shared/features/headerfooter'
import { applyGroup, removeGroup } from '../../src/renderer/src/features/headerfooter/pdf/ops'
import { previewBytes } from '../../src/renderer/src/features/headerfooter/pdf/preview'
import { fixtureBytes, openWith } from './helpers/securityHelpers'
import { setupText } from './helpers/text'

/**
 * Page marks on the working copy of an unlocked password-protected document: in-place edits (apply, update, remove
 * and its clean-up of unused objects) must KEEP the protection marker (it is what makes Save re-encrypt); the preview,
 * a new document derived from the working copy, must never contain it.
 */
setupText()

async function markedWorkingCopy(): Promise<Uint8Array> {
  const opened = await openWith(fixtureBytes('aes-256-r6'), 'user256')
  const pdf = await PDFDocument.load(opened.plain, { updateMetadata: false })
  embedMarker(pdf, await makeProtection(pdf, { algorithm: 'aes256', userPassword: 'user256', ownerPassword: 'owner256', P: -4, encryptMetadata: true }))
  return pdf.save()
}

const leaks = (b: Uint8Array): boolean => Buffer.from(b).toString('latin1').includes(MARKER_NEEDLE) || Buffer.from(b).toString('latin1').includes('EpdfSecurity')

describe('protection marker', () => {
  it('apply, replace and remove keep it (in-place edits); the preview never has it', async () => {
    const start = await markedWorkingCopy()
    expect(hasMarker(start)).toBe(true)
    const pdf = await PDFDocument.load(start, { updateMetadata: false })
    await applyGroup(pdf, { group: 'watermark', settings: defaultWatermark() }, { mode: 'replace', fileName: 'x' })
    await applyGroup(pdf, { group: 'headerfooter', settings: defaultHeaderFooter() }, { mode: 'replace', fileName: 'x' })
    const applied = await pdf.save()
    expect(hasMarker(applied)).toBe(true)
    const again = await PDFDocument.load(applied, { updateMetadata: false })
    await applyGroup(again, { group: 'watermark', settings: { ...defaultWatermark(), opacity: 0.5 } }, { mode: 'replace', fileName: 'x' })
    await removeGroup(again, 'headerfooter')
    await removeGroup(again, 'watermark')
    expect(hasMarker(await again.save())).toBe(true)

    const pv = await previewBytes({ base: await PDFDocument.load(applied, { updateMetadata: false }), pageIndex: 0, gs: { group: 'watermark', settings: defaultWatermark() }, mode: 'replace', fileName: 'x', withMarks: true })
    expect(leaks(pv)).toBe(false)
  })
})
