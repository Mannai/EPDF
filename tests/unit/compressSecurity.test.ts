import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { pureCodec } from '../../src/renderer/src/features/compress/pdf/codec'
import { compressPdf } from '../../src/renderer/src/features/compress/pdf/compress'
import { PRESETS } from '../../src/renderer/src/features/compress/pdf/options'
import { applyMarkerProtection, embedMarker, hasMarker, inspectEncryption, makeProtection } from '../../src/renderer/src/features/security/crypto/document'
import { addRawImage, baseDoc, photoRGB, placeAt } from './compressHelpers'

/**
 * Regression: the Security feature marks the in-memory copy of a password-protected document with a plain-ASCII marker stream and
 * re-encrypts on every write by finding it with a raw byte search. Compressing (or packing into object streams) that stream made
 * the search fail, so the reduced document would have been saved UNENCRYPTED. The marker must survive byte-for-byte.
 */
describe('compression keeps the Security protection marker findable', () => {
  it.each(['balanced', 'smallest'] as const)('%s: a marked document is still re-encrypted on write', async (preset) => {
    const { doc, page } = await baseDoc()
    placeAt(page, addRawImage(doc, { w: 800, h: 600, data: photoRGB(800, 600, 9), cs: 'DeviceRGB' }), 20, 300, 216, 162)
    const protection = await makeProtection(doc, { algorithm: 'aes256', userPassword: 'secret', ownerPassword: 'owner', P: -4, encryptMetadata: true })
    embedMarker(doc, protection)
    const marked = await doc.save()
    expect(hasMarker(marked)).toBe(true)

    const r = await compressPdf(marked, PRESETS[preset], { codec: pureCodec })
    expect(r.kept).toBe('result')
    expect(hasMarker(r.bytes)).toBe(true) // still a plain byte sequence: not deflated, not inside an object stream

    const written = await applyMarkerProtection(r.bytes) // what Save does through the beforeWrite hook
    expect(hasMarker(written)).toBe(false)
    const probe = await inspectEncryption(written)
    expect(probe).not.toBeNull()
    await expect(PDFDocument.load(written)).rejects.toThrow(/encrypt/i)
  })
})
