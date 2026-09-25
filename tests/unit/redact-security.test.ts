import { PDFDocument, PDFName, PDFStream, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { ALL_PERMISSIONS, permissionsToP } from '@shared/features/security'
import { MARKER_NEEDLE, applyMarkerProtection, embedMarker, hasMarker, makeProtection, readMarker } from '../../src/renderer/src/features/security/crypto/document'
import { DEFAULT_OPTIONS, redactDocument } from '../../src/renderer/src/features/redact/logic/redact'
import { verifyRedaction } from '../../src/renderer/src/features/redact/logic/verify'
import { readPdf, flattenText } from '../support/pdfText'
import { openWith } from './helpers/securityHelpers'

/**
 * A protected document is edited as plaintext carrying an in-memory "protection marker" (with the key). The
 * redaction must keep it working (saving re-encrypts) and must never copy the marker or key anywhere else.
 */

const SECRET = 'PROTECTEDSECRET-31337'

async function protectedPlain(): Promise<{ bytes: Uint8Array; keyHex: string }> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([612, 792])
  page.drawText(`Confidential ${SECRET} inside`, { x: 72, y: 700, size: 14, font })
  page.drawText('A line that stays', { x: 72, y: 650, size: 14, font })
  doc.setTitle(`About ${SECRET}`)
  const protection = await makeProtection(doc, { algorithm: 'aes256', userPassword: 'open sesame', ownerPassword: 'boss', P: permissionsToP(ALL_PERMISSIONS), encryptMetadata: true })
  embedMarker(doc, protection)
  const hex = Array.from(protection.key, (b) => b.toString(16).padStart(2, '0')).join('')
  return { bytes: await doc.save(), keyHex: hex }
}

describe('redaction of a protected document', () => {
  it('keeps the marker (so saving re-encrypts), leaks neither marker nor key, and the saved file hides the secret', async () => {
    const { bytes, keyHex } = await protectedPlain()
    expect(hasMarker(bytes)).toBe(true)
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
    const res = redactDocument(pdf, [{ id: 'a', pageIndex: 0, rects: [{ x0: 60, y0: 690, x1: 400, y1: 720 }], text: SECRET }], { ...DEFAULT_OPTIONS, removeMetadata: true, removeHidden: true })
    const plainOut = await pdf.save()

    // the marker is still exactly once, still readable, and its content did not travel anywhere else
    const text = Buffer.from(plainOut).toString('latin1')
    expect(text.split(MARKER_NEEDLE).length - 1).toBe(1)
    expect(text.split(keyHex).length - 1).toBe(1)
    const reread = await PDFDocument.load(plainOut, { updateMetadata: false })
    expect(readMarker(reread)).not.toBeNull()
    let markerStreams = 0
    for (const [, o] of reread.context.enumerateIndirectObjects()) if (o instanceof PDFStream && String(o.dict.lookup(PDFName.of('Type'))) === '/EpdfSecurity') markerStreams++
    expect(markerStreams).toBe(1)

    // the self-check neither trips over the marker nor lets the secret through
    expect(await verifyRedaction({ bytes: plainOut, marksByPage: res.marksByPage, shapesByPage: res.shapesByPage, secrets: res.secrets })).toEqual([])
    // a redacted string that happens to occur in the marker's JSON must not be mistaken for content either
    expect(await verifyRedaction({ bytes: plainOut, marksByPage: res.marksByPage, secrets: ['algorithm', 'stmFilterName', keyHex.slice(0, 12), 'EPDF-SECURITY'] })).toEqual([])

    // what reaches the disk: encrypted, no marker, no key, no secret; opens with the password; redacted
    const onDisk = await applyMarkerProtection(plainOut)
    expect(hasMarker(onDisk)).toBe(false)
    const disk = Buffer.from(onDisk).toString('latin1')
    expect(disk).not.toContain(keyHex)
    expect(disk).not.toContain('EpdfSecurity')
    expect(disk).not.toContain(SECRET)
    expect(disk).toContain('/Encrypt')
    const opened = await openWith(onDisk, 'open sesame')
    const { pages } = await readPdf(new Uint8Array(opened.plain))
    expect(flattenText(pages)).toContain('A line that stays')
    expect(flattenText(pages)).not.toContain('PROTECTEDSECRET')
    expect(Buffer.from(opened.plain).toString('latin1')).not.toContain(SECRET)
  })
})
