import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream } from 'pdf-lib'
import { afterAll, describe, expect, it } from 'vitest'
import { ALL_PERMISSIONS, permissionsToP } from '@shared/features/security'
import { aesPdfDecrypt, aesPdfEncrypt } from '../../src/renderer/src/features/security/crypto/aes'
import { BULK_THRESHOLD, webAesDecrypt, webAesEncrypt } from '../../src/renderer/src/features/security/crypto/bulk'
import { concat, equalBytes, fromHex, latin1, randomBytes, toHex, utf8 } from '../../src/renderer/src/features/security/crypto/bytes'
import {
  applyMarkerProtection,
  decryptDocument,
  embedMarker,
  hasMarker,
  inspectEncryption,
  makeProtection,
  parseProtection,
  protectBytes,
  readMarker,
  removeMarker
} from '../../src/renderer/src/features/security/crypto/document'
import { authenticate, createProtection, UnsupportedEncryptionError } from '../../src/renderer/src/features/security/crypto/handler'
import { _resetEditHooks, registerEditHooks, runBeforeWrite } from '../../src/renderer/src/edit/hooks'
import { allStreamText, fixtureBytes, openWith } from './helpers/securityHelpers'
import { assemble, encryptDictText, pageObjects, rawEncryption, showText, streamObject } from './helpers/rawPdf'

const QPDF = process.env.QPDF ?? 'C:\\Program Files\\qpdf 12.4.1\\bin\\qpdf.exe'
const haveQpdf = existsSync(QPDF)
const tmp = mkdtempSync(join(tmpdir(), 'epdf-sec-edge-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

async function pdfjsText(bytes: Uint8Array, password?: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: bytes.slice(), password, verbosity: 0, useSystemFonts: false, disableFontFace: true })
  const doc = await task.promise
  try {
    let text = ''
    for (let i = 1; i <= doc.numPages; i++) text += (await (await doc.getPage(i)).getTextContent()).items.map((t) => ('str' in t ? t.str : '')).join(' ') + '\n'
    return text
  } finally {
    await task.destroy()
  }
}

function qpdf(args: string[]): string {
  try {
    return execFileSync(QPDF, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    throw new Error(`qpdf ${args.join(' ')}\n${e.stdout}${e.stderr}`)
  }
}

describe('hand-assembled encrypted files (things pdf-lib cannot write)', () => {
  it('/Identity crypt filter: a stream that names it stays plaintext and is read as such; other streams are decrypted', async () => {
    const enc = await rawEncryption({ algorithm: 'aes128', userPassword: 'uu', ownerPassword: 'oo', P: -4, encryptMetadata: true })
    const objs = pageObjects('', [
      { num: 6, body: streamObject('/Filter [/Crypt] /DecodeParms [<< /Type /CryptFilterDecodeParms /Name /Identity >>]', showText('Identity stream text')) },
      { num: 7, body: `<< /Title ${enc.str(7, 'Identity Title')} >>` },
      { num: 8, body: encryptDictText(enc.protection) },
      { num: 9, body: streamObject('/Filter [/Crypt] /DecodeParms [<< /Name /StdCF >>]', enc.stream(9, showText('Named filter text'))) }
    ])
    objs[2].body = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [4 0 R 6 0 R 9 0 R] /Resources << /Font << /F1 5 0 R >> >> >>'
    objs[3].body = streamObject('', enc.stream(4, showText('Encrypted stream text')))
    const id = toHex(enc.protection.info.id0)
    const { bytes } = assemble(objs, `/Root 1 0 R /Info 7 0 R /Encrypt 8 0 R /ID [<${id}> <${id}>]`)

    const o = await openWith(bytes, 'uu')
    const text = await allStreamText(o.plain)
    expect(text).toContain('(Encrypted stream text) Tj')
    expect(text).toContain('(Identity stream text) Tj')
    expect(text).toContain('(Named filter text) Tj')
    expect(latin1(o.plain)).not.toMatch(/\/Crypt\b/) // the Crypt filter entries are gone from the plain copy
    const viaPdfjs = await pdfjsText(bytes, 'uu')
    for (const s of ['Encrypted stream text', 'Identity stream text', 'Named filter text']) expect(viaPdfjs).toContain(s)
  })

  it.skipIf(!haveQpdf)('qpdf reads the same Identity-filter file the same way (independent check of our reading)', async () => {
    const enc = await rawEncryption({ algorithm: 'aes128', userPassword: 'uu', ownerPassword: 'oo', P: -4, encryptMetadata: true })
    const objs = pageObjects('', [
      { num: 6, body: streamObject('/Filter [/Crypt] /DecodeParms [<< /Type /CryptFilterDecodeParms /Name /Identity >>]', showText('Identity stream text')) },
      { num: 7, body: `<< /Title ${enc.str(7, 'Identity Title')} >>` },
      { num: 8, body: encryptDictText(enc.protection) }
    ])
    objs[2].body = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [4 0 R 6 0 R] /Resources << /Font << /F1 5 0 R >> >> >>'
    objs[3].body = streamObject('', enc.stream(4, showText('Encrypted stream text')))
    const id = toHex(enc.protection.info.id0)
    const { bytes } = assemble(objs, `/Root 1 0 R /Info 7 0 R /Encrypt 8 0 R /ID [<${id}> <${id}>]`)
    const f = join(tmp, 'identity.pdf')
    writeFileSync(f, bytes)
    expect(qpdf(['--password=uu', '--check', f])).toContain('No syntax or stream encoding errors found')
    const out = join(tmp, 'identity-dec.pdf')
    qpdf(['--password=uu', '--decrypt', f, out])
    const text = await allStreamText(new Uint8Array(readFileSync(out)))
    expect(text).toContain('(Encrypted stream text) Tj')
    expect(text).toContain('(Identity stream text) Tj')
    // And our own decryption is the same document.
    const ours = await allStreamText((await openWith(bytes, 'uu')).plain)
    expect(ours).toContain('(Identity stream text) Tj')
  })

  it('/StrF /Identity: strings are left as they are while streams are encrypted', async () => {
    const enc = await rawEncryption({ algorithm: 'aes128', userPassword: '', ownerPassword: 'oo', P: -4, encryptMetadata: true })
    enc.protection.info.strMethod = 'None'
    enc.protection.info.strFilterName = 'Identity'
    const objs = pageObjects(streamObject('', enc.stream(4, showText('Body text'))), [
      { num: 7, body: '<< /Title (Plain Title) >>' },
      { num: 8, body: encryptDictText(enc.protection) }
    ])
    const id = toHex(enc.protection.info.id0)
    const { bytes } = assemble(objs, `/Root 1 0 R /Info 7 0 R /Encrypt 8 0 R /ID [<${id}> <${id}>]`)
    const o = await openWith(bytes, '')
    expect(o.info.strMethod).toBe('None')
    const doc = await PDFDocument.load(o.plain, { updateMetadata: false })
    expect(doc.getTitle()).toBe('Plain Title')
    expect(await allStreamText(o.plain)).toContain('(Body text) Tj')
  })

  it('a direct /Encrypt dictionary in the trailer (not an indirect object), RC4-128', async () => {
    const enc = await rawEncryption({ algorithm: 'rc4-128', userPassword: 'direct', ownerPassword: 'own', P: -4, encryptMetadata: true })
    const objs = pageObjects(streamObject('', enc.stream(4, showText('Direct dict text'))), [{ num: 7, body: `<< /Title ${enc.str(7, 'Direct Title')} >>` }])
    const id = toHex(enc.protection.info.id0)
    const { bytes } = assemble(objs, `/Root 1 0 R /Info 7 0 R /Encrypt ${encryptDictText(enc.protection)} /ID [<${id}> <${id}>]`)
    const probe = await inspectEncryption(bytes)
    expect(probe?.encryptRef).toBeUndefined()
    const o = await openWith(bytes, 'direct')
    expect(await allStreamText(o.plain)).toContain('(Direct dict text) Tj')
    expect((await PDFDocument.load(o.plain, { updateMetadata: false })).getTitle()).toBe('Direct Title')
    expect(await pdfjsText(bytes, 'direct')).toContain('Direct dict text')
  })

  it('an incremental update that repeats /Encrypt: the newer object wins and is decrypted with the same key', async () => {
    const enc = await rawEncryption({ algorithm: 'rc4-128', userPassword: 'inc', ownerPassword: 'own', P: -4, encryptMetadata: true })
    const first = pageObjects(streamObject('', enc.stream(4, showText('First revision'))), [
      { num: 7, body: `<< /Title ${enc.str(7, 'Old Title')} >>` },
      { num: 8, body: encryptDictText(enc.protection) }
    ])
    const id = toHex(enc.protection.info.id0)
    const trailer = `/Root 1 0 R /Info 7 0 R /Encrypt 8 0 R /ID [<${id}> <${id}>]`
    const base = assemble(first, trailer)
    const update = assemble(
      [
        { num: 4, body: streamObject('', enc.stream(4, showText('Second revision'))) },
        { num: 7, body: `<< /Title ${enc.str(7, 'New Title')} >>` }
      ],
      trailer,
      { size: 9, prev: { bytes: base.bytes, xrefOffset: base.xrefOffset } }
    )
    const o = await openWith(update.bytes, 'inc')
    const text = await allStreamText(o.plain)
    expect(text).toContain('(Second revision) Tj')
    expect(text).not.toContain('First revision')
    expect((await PDFDocument.load(o.plain, { updateMetadata: false })).getTitle()).toBe('New Title')
    expect(await pdfjsText(update.bytes, 'inc')).toContain('Second revision')
  })

  it.skipIf(!haveQpdf)('qpdf agrees the incremental-update file is valid', async () => {
    const enc = await rawEncryption({ algorithm: 'aes128', userPassword: 'inc', ownerPassword: 'own', P: -4, encryptMetadata: true })
    const first = pageObjects(streamObject('', enc.stream(4, showText('First revision'))), [
      { num: 7, body: `<< /Title ${enc.str(7, 'Old Title')} >>` },
      { num: 8, body: encryptDictText(enc.protection) }
    ])
    const id = toHex(enc.protection.info.id0)
    const trailer = `/Root 1 0 R /Info 7 0 R /Encrypt 8 0 R /ID [<${id}> <${id}>]`
    const base = assemble(first, trailer)
    const update = assemble([{ num: 4, body: streamObject('', enc.stream(4, showText('Second revision'))) }], trailer, { size: 9, prev: { bytes: base.bytes, xrefOffset: base.xrefOffset } })
    const f = join(tmp, 'inc.pdf')
    writeFileSync(f, update.bytes)
    expect(qpdf(['--password=inc', '--check', f])).toContain('No syntax or stream encoding errors found')
  })
})

describe('bulk paths agree with the synchronous ciphers', () => {
  it('WebCrypto AES (with the padding trick) matches the pure implementation around the block and threshold sizes', async () => {
    for (const n of [0, 1, 15, 16, 17, 31, 32, 4095, 4096, BULK_THRESHOLD - 1, BULK_THRESHOLD, BULK_THRESHOLD + 17, 1_500_003]) {
      for (const keyLen of [16, 32]) {
        const key = randomBytes(keyLen)
        const data = randomBytes(n)
        const iv = randomBytes(16)
        const viaWeb = await webAesEncrypt(key, data, iv)
        expect(equalBytes(viaWeb, aesPdfEncrypt(key, data, iv)), `enc ${n}/${keyLen}`).toBe(true)
        expect(equalBytes(await webAesDecrypt(key, viaWeb), data), `dec ${n}/${keyLen}`).toBe(true)
        expect(equalBytes(aesPdfDecrypt(key, viaWeb), data)).toBe(true)
      }
    }
  })

  it('damaged AES padding does not throw: the bytes are kept', async () => {
    const key = randomBytes(16)
    const good = aesPdfEncrypt(key, utf8('some text that is longer than one block!'))
    // Flip a bit in the last block: padding becomes garbage.
    const bad = good.slice()
    bad[bad.length - 1] ^= 0x55
    expect(() => aesPdfDecrypt(key, bad)).not.toThrow()
    await expect(webAesDecrypt(key, bad)).resolves.toBeInstanceOf(Uint8Array)
  })

  for (const alg of ['aes256', 'aes128', 'rc4-128'] as const) {
    it(`a document with a multi-megabyte stream round-trips (${alg})`, async () => {
      const doc = await PDFDocument.create()
      doc.addPage()
      const big = randomBytes(3_000_000)
      const ref = doc.context.register(doc.context.stream(big, { Type: 'EmbeddedFile' }))
      doc.catalog.set(PDFName.of('BigStream'), ref)
      const plain = await doc.save({ useObjectStreams: false })
      const enc = await protectBytes(plain, { algorithm: alg, userPassword: 'u', ownerPassword: 'o', P: permissionsToP(ALL_PERMISSIONS), encryptMetadata: true })
      const { plain: back } = await openWith(enc, 'u')
      const reloaded = await PDFDocument.load(back, { updateMetadata: false })
      const stream = reloaded.context.lookup(reloaded.catalog.get(PDFName.of('BigStream')))
      expect(stream).toBeInstanceOf(PDFRawStream)
      expect(equalBytes((stream as PDFRawStream).contents, big)).toBe(true)
    }, 60_000)
  }
})

describe('the protection marker', () => {
  const makePlain = async (): Promise<Uint8Array> => {
    const d = await PDFDocument.create()
    d.addPage([200, 200])
    d.setTitle('Marker test')
    return d.save()
  }

  it('embed, serialise, read back and remove', async () => {
    const pdf = await PDFDocument.load(await makePlain())
    const p = await makeProtection(pdf, { algorithm: 'aes256', userPassword: 'a', ownerPassword: 'b', P: -4, encryptMetadata: true })
    embedMarker(pdf, p)
    const bytes = await pdf.save() // default save packs objects into object streams: the marker must stay findable
    expect(hasMarker(bytes)).toBe(true)
    const again = await PDFDocument.load(bytes)
    const back = readMarker(again)!
    expect(toHex(back.key)).toBe(toHex(p.key))
    expect(back.info.R).toBe(6)
    expect(toHex(back.info.U)).toBe(toHex(p.info.U))
    expect(removeMarker(again)).toBe(true)
    expect(hasMarker(await again.save())).toBe(false)
    expect(readMarker(again)).toBeNull()
  })

  it('survives repeated load/modify/save cycles like the edit pipeline does', async () => {
    const pdf = await PDFDocument.load(await makePlain())
    embedMarker(pdf, await makeProtection(pdf, { algorithm: 'aes128', userPassword: 'a', ownerPassword: 'b', P: -4, encryptMetadata: true }))
    let bytes = await pdf.save()
    for (let i = 0; i < 3; i++) {
      const d = await PDFDocument.load(bytes, { updateMetadata: false })
      d.addPage([100 + i, 100])
      d.setProducer('Epdf')
      bytes = await d.save()
    }
    expect(hasMarker(bytes)).toBe(true)
    const enc = await applyMarkerProtection(bytes)
    expect(hasMarker(enc)).toBe(false)
    expect((await inspectEncryption(enc))?.info.R).toBe(4)
    expect((await PDFDocument.load((await openWith(enc, 'a')).plain)).getPageCount()).toBe(4)
  })

  it('a snapshot without a marker passes through untouched (same bytes, no work), including encrypted originals', async () => {
    const plain = await makePlain()
    expect(await applyMarkerProtection(plain)).toBe(plain)
    const encrypted = fixtureBytes('aes-256-r6')
    expect(await applyMarkerProtection(encrypted)).toBe(encrypted)
  })

  it('the encrypted output never contains the marker or the file key', async () => {
    const pdf = await PDFDocument.load(await makePlain())
    const p = await makeProtection(pdf, { algorithm: 'aes256', userPassword: 'a', ownerPassword: 'b', P: -4, encryptMetadata: true })
    embedMarker(pdf, p)
    const enc = await applyMarkerProtection(await pdf.save())
    const raw = latin1(enc)
    expect(raw.includes('EPDF-SECURITY')).toBe(false)
    expect(raw.includes('EpdfSecurity')).toBe(false)
    expect(raw.includes(toHex(p.key))).toBe(false)
  })

  it('the same protection is written every time (same passwords open the re-encrypted file), with fresh IVs', async () => {
    const pdf = await PDFDocument.load(await makePlain())
    embedMarker(pdf, await makeProtection(pdf, { algorithm: 'aes256', userPassword: 'keep', ownerPassword: 'own', P: -4, encryptMetadata: true }))
    const snapshot = await pdf.save()
    const a = await applyMarkerProtection(snapshot)
    const b = await applyMarkerProtection(snapshot)
    expect(equalBytes(a, b)).toBe(false)
    for (const enc of [a, b]) expect((await openWith(enc, 'keep')).access.kind).toBe('user')
    const pa = (await inspectEncryption(a))!.info
    const pb = (await inspectEncryption(b))!.info
    expect(toHex(pa.U)).toBe(toHex(pb.U))
    expect(toHex(pa.id0)).toBe(toHex(pb.id0))
  })

  it('parseProtection rejects garbage', () => {
    expect(parseProtection(utf8('nope'))).toBeNull()
    expect(parseProtection(utf8('EPDF-SECURITY-MARKER-1\n{not json'))).toBeNull()
  })
})

describe('the beforeWrite hook contract', () => {
  it('re-encrypts marked snapshots and leaves everything else alone', async () => {
    _resetEditHooks()
    registerEditHooks({ beforeWrite: (_id, bytes) => applyMarkerProtection(bytes) })
    const pdf = await PDFDocument.create()
    pdf.addPage()
    embedMarker(pdf, await makeProtection(pdf, { algorithm: 'aes256', userPassword: 'x', ownerPassword: 'y', P: -4, encryptMetadata: true }))
    const out = await runBeforeWrite('d', await pdf.save())
    expect(latin1(out)).toContain('/Encrypt')
    const plain = await (await PDFDocument.create()).save()
    expect(await runBeforeWrite('d', plain)).toBe(plain)
    _resetEditHooks()
  })
})

describe('failure modes', () => {
  it('certificate (public-key) encryption is reported clearly, not mis-decrypted', async () => {
    const objs = pageObjects(streamObject('', showText('x')), [{ num: 8, body: '<< /Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s5 /V 4 /Length 128 >>' }])
    const { bytes } = assemble(objs, '/Root 1 0 R /Encrypt 8 0 R /ID [<00> <00>]')
    await expect(inspectEncryption(bytes)).rejects.toThrow(UnsupportedEncryptionError)
    await expect(inspectEncryption(bytes)).rejects.toThrow(/certificate|security handler/i)
  })

  it('an incomplete encryption dictionary is rejected', async () => {
    const objs = pageObjects(streamObject('', showText('x')), [{ num: 8, body: '<< /Filter /Standard /V 2 /R 3 /Length 128 /P -4 >>' }])
    const { bytes } = assemble(objs, '/Root 1 0 R /Encrypt 8 0 R /ID [<00> <00>]')
    await expect(inspectEncryption(bytes)).rejects.toThrow(/incomplete/)
  })

  it('an unknown version is rejected', async () => {
    const objs = pageObjects(streamObject('', showText('x')), [{ num: 8, body: `<< /Filter /Standard /V 9 /R 9 /P -4 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> >>` }])
    const { bytes } = assemble(objs, '/Root 1 0 R /Encrypt 8 0 R /ID [<00> <00>]')
    await expect(inspectEncryption(bytes)).rejects.toThrow(/Unsupported encryption/)
  })

  it('not encrypted -> null; wrong password -> null access', async () => {
    expect(await inspectEncryption(fixtureBytes('plain'))).toBeNull()
    const probe = (await inspectEncryption(fixtureBytes('aes-128')))!
    expect(await authenticate(probe.info, 'wrong')).toBeNull()
  })

  it('a truncated encrypted stream decrypts to something rather than throwing', async () => {
    const enc = await rawEncryption({ algorithm: 'aes128', userPassword: '', ownerPassword: 'o', P: -4, encryptMetadata: true })
    const whole = enc.stream(4, showText('some content to cut'))
    const objs = pageObjects(streamObject('', whole.subarray(0, 21)), [{ num: 8, body: encryptDictText(enc.protection) }])
    const id = toHex(enc.protection.info.id0)
    const { bytes } = assemble(objs, `/Root 1 0 R /Encrypt 8 0 R /ID [<${id}> <${id}>]`)
    const o = await openWith(bytes, '')
    expect(o.plain.length).toBeGreaterThan(100)
  })

  it('createProtection keeps the given first ID and is deterministic in what it derives from it (R4)', async () => {
    const id0 = fromHex('00112233445566778899aabbccddeeff')
    const a = await createProtection({ algorithm: 'aes128', userPassword: 'p', ownerPassword: 'q', P: -4, encryptMetadata: true, id0 })
    const b = await createProtection({ algorithm: 'aes128', userPassword: 'p', ownerPassword: 'q', P: -4, encryptMetadata: true, id0 })
    expect(toHex(a.key)).toBe(toHex(b.key))
    expect(toHex(a.info.O)).toBe(toHex(b.info.O))
    expect(toHex(a.info.U)).toBe(toHex(b.info.U))
    expect(a.info.O).toHaveLength(32)
  })

  it('decrypting keeps signature /Contents untouched', async () => {
    const enc = await rawEncryption({ algorithm: 'aes128', userPassword: '', ownerPassword: 'o', P: -4, encryptMetadata: true })
    const sig = '<< /Type /Sig /Filter /Adobe.PPKLite /ByteRange [0 10 20 30] /Contents <DEADBEEF00> /Reason ' + enc.str(7, 'Approved') + ' >>'
    const objs = pageObjects(streamObject('', enc.stream(4, showText('x'))), [
      { num: 7, body: sig },
      { num: 8, body: encryptDictText(enc.protection) }
    ])
    const id = toHex(enc.protection.info.id0)
    const { bytes } = assemble(objs, `/Root 1 0 R /Encrypt 8 0 R /ID [<${id}> <${id}>]`)
    const doc = await PDFDocument.load((await openWith(bytes, '')).plain, { updateMetadata: false })
    const sigDict = doc.context.lookup(doc.context.obj({}) && (await findRef(doc, 7))) as PDFDict
    expect(sigDict.lookup(PDFName.of('Contents'))).toBeInstanceOf(PDFHexString)
    expect((sigDict.lookup(PDFName.of('Contents')) as PDFHexString).asBytes()).toEqual(fromHex('deadbeef00'))
    expect((sigDict.lookup(PDFName.of('Reason')) as PDFHexString).decodeText()).toBe('Approved')
  })
})

async function findRef(doc: PDFDocument, num: number): Promise<never> {
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) if (ref.objectNumber === num) return obj as never
  throw new Error(`object ${num} not found`)
}

describe('misc structure', () => {
  it('unused import guard', () => {
    expect(concat(new Uint8Array([1]), new Uint8Array([2]))).toEqual(new Uint8Array([1, 2]))
    expect(PDFArray).toBeDefined()
    expect(decryptDocument).toBeDefined()
  })
})
