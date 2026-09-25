import { createCipheriv, createHash } from 'node:crypto'
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRawStream, PDFRef, PDFString, StandardFonts, type PDFObject } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { ALL_PERMISSIONS, hasBit, permissionsToP, pToPermissions, type Algorithm, type Permissions } from '@shared/features/security'
import { concat, equalBytes, fromHex, toHex, utf8 } from '../../src/renderer/src/features/security/crypto/bytes'
import { inspectEncryption, protectBytes } from '../../src/renderer/src/features/security/crypto/document'
import { authenticate, passwordBytesR6, passwordCandidatesLegacy, saslPrep } from '../../src/renderer/src/features/security/crypto/handler'
import { hashR6 } from '../../src/renderer/src/features/security/crypto/hash'
import { openWith } from './helpers/securityHelpers'

/** Deterministic PRNG so a failing case can be replayed from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]
const int = (rng: () => number, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1))
const rbytes = (rng: () => number, n: number): Uint8Array => Uint8Array.from({ length: n }, () => Math.floor(rng() * 256))

const ALPHABET = ['a', 'Z', '7', ' ', '-', 'ä', 'ö', 'ü', 'ß', '€', '中', 'Ж', '😀', 'é', 'ñ', '!']
const randText = (rng: () => number, max: number): string => Array.from({ length: int(rng, 0, max) }, () => pick(rng, ALPHABET)).join('')

async function randomDoc(rng: () => number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < int(rng, 1, 4); i++) {
    const p = doc.addPage([int(rng, 100, 700), int(rng, 100, 700)])
    p.drawText(`Page ${i} ${int(rng, 0, 99999)}`, { x: 10, y: 50, size: 12, font })
  }
  doc.setTitle(randText(rng, 30))
  doc.setAuthor(randText(rng, 30))
  doc.setSubject(randText(rng, 5))
  const ctx = doc.context
  // Random binary streams and random strings (empty, binary, unicode) hanging off the catalog.
  for (let i = 0; i < int(rng, 0, 3); i++) {
    const ref = ctx.register(ctx.stream(rbytes(rng, int(rng, 0, 4000)), { Type: 'Extra', Note: PDFString.of(randText(rng, 6)) }))
    doc.catalog.set(PDFName.of(`Blob${i}`), ref)
  }
  const strs = ctx.obj([])
  for (let i = 0; i < int(rng, 0, 6); i++) strs.push(rng() < 0.5 ? PDFHexString.of(Buffer.from(rbytes(rng, int(rng, 0, 40))).toString('hex')) : PDFString.of(randText(rng, 12).replace(/[()\\]/g, '')))
  doc.catalog.set(PDFName.of('Strs'), strs)
  return doc.save({ useObjectStreams: rng() < 0.5 })
}

/** Canonical text of every object of a document, keyed by reference, for exact before/after comparison. */
async function dump(bytes: Uint8Array): Promise<Map<string, string>> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const canon = (o: PDFObject | undefined): string => {
    if (o === undefined) return 'undef'
    if (o instanceof PDFRef) return `R${o.objectNumber}.${o.generationNumber}`
    if (o instanceof PDFName) return o.asString()
    if (o instanceof PDFNumber) return String(o.asNumber())
    if (o instanceof PDFBool) return String(o.asBoolean())
    if (o === (PDFNull as unknown)) return 'null'
    if (o instanceof PDFString || o instanceof PDFHexString) return `s<${toHex(o.asBytes())}>`
    if (o instanceof PDFArray) return `[${o.asArray().map(canon).join(' ')}]`
    if (o instanceof PDFDict) {
      return `<<${o
        .entries()
        .filter(([k]) => k.asString() !== '/Length' && k.asString() !== '/Extensions') // /Extensions: added for AES-256 by design
        .map(([k, v]) => `${k.asString()} ${canon(v)}`)
        .sort()
        .join(' ')}>>`
    }
    if (o instanceof PDFRawStream) return `${canon(o.dict)}stream:${createHash('sha1').update(o.contents).digest('hex')}`
    return `?${o.constructor.name}`
  }
  const out = new Map<string, string>()
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) out.set(`${ref.objectNumber}.${ref.generationNumber}`, canon(obj))
  return out
}

const randPassword = (rng: () => number): string => {
  const kind = int(rng, 0, 4)
  if (kind === 0) return ''
  if (kind === 1) return randText(rng, 8) || 'x'
  if (kind === 2) return 'pw' + int(rng, 0, 1e6)
  if (kind === 3) return 'L'.repeat(int(rng, 33, 200))
  return randText(rng, 40) || 'y'
}

const randPerms = (rng: () => number): Permissions => ({
  print: pick(rng, ['none', 'low', 'high'] as const),
  copy: rng() < 0.5,
  edit: rng() < 0.5,
  annotate: rng() < 0.5,
  fillForms: rng() < 0.5,
  assemble: rng() < 0.5,
  accessibility: rng() < 0.5
})

describe('round-trip fuzz: random documents, passwords, permissions and algorithms', () => {
  const ALGS: Algorithm[] = ['aes256', 'aes128', 'rc4-128']
  it('encrypt then decrypt reproduces every object exactly (200 seeded cases)', async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = mulberry32(seed)
      const plain = await randomDoc(rng)
      const alg = ALGS[seed % 3]
      const user = randPassword(rng)
      const owner = rng() < 0.2 ? '' : randPassword(rng) || 'own'
      const perms = randPerms(rng)
      const meta = rng() < 0.7
      const label = `seed ${seed} ${alg} user=${JSON.stringify(user.slice(0, 12))} owner=${JSON.stringify(owner.slice(0, 12))}`

      const enc = await protectBytes(plain, { algorithm: alg, userPassword: user, ownerPassword: owner, P: permissionsToP(perms), encryptMetadata: meta })
      const probe = (await inspectEncryption(enc))!
      expect(probe.info.P, label).toBe(permissionsToP(perms))
      expect(probe.info.encryptMetadata, label).toBe(alg === 'rc4-128' ? true : meta)

      const u = await authenticate(probe.info, user)
      expect(u, `user ${label}`).not.toBeNull()
      if (owner) expect((await authenticate(probe.info, owner))?.kind, `owner ${label}`).toBe('owner')
      // Passwords are used in full only up to their limit (32 bytes for R<=4, 127 for R6): a different first byte never matches.
      const wrong = await authenticate(probe.info, 'x\u0001' + user + owner)
      expect(wrong === null || user === '' || owner === '', `wrong ${label}`).toBe(true)

      const back = (await openWith(enc, user)).plain
      const a = await dump(plain)
      const b = await dump(back)
      // The plain source had no /Encrypt; the decrypted copy must equal it object for object.
      expect([...b.keys()].sort(), label).toEqual([...a.keys()].sort())
      for (const [k, v] of a) expect(b.get(k), `${label} object ${k}`).toBe(v)
    }
  }, 300_000)
})

describe('Algorithm 2.B (revision 6 hash) against an independent implementation on Node crypto', () => {
  function reference(password: Uint8Array, salt: Uint8Array, udata: Uint8Array): Uint8Array {
    const sha = (bits: number, d: Buffer): Buffer => createHash(`sha${bits}`).update(d).digest()
    let k = sha(256, Buffer.concat([password, salt, udata]))
    let i = 0
    for (;;) {
      const k1 = Buffer.concat(Array.from({ length: 64 }, () => Buffer.concat([password, k, udata])))
      const c = createCipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32))
      c.setAutoPadding(false)
      const e = Buffer.concat([c.update(k1), c.final()])
      const m = Number(BigInt('0x' + e.subarray(0, 16).toString('hex')) % 3n)
      k = sha([256, 384, 512][m], e)
      i++
      if (i >= 64 && e[e.length - 1] <= i - 32) break
    }
    return k.subarray(0, 32)
  }

  it('matches on random passwords, salts and user data (with and without udata)', async () => {
    const rng = mulberry32(99)
    for (let n = 0; n < 40; n++) {
      const pw = rbytes(rng, int(rng, 0, 127))
      const salt = rbytes(rng, 8)
      const udata = n % 2 ? rbytes(rng, 48) : new Uint8Array(0)
      expect(toHex(await hashR6(pw, salt, udata)), `case ${n}`).toBe(toHex(reference(pw, salt, udata)))
    }
  })

  it('the qpdf revision 6 fixture verifies against the hash (published-by-another-implementation values)', async () => {
    const { fixtureBytes } = await import('./helpers/securityHelpers')
    const info = (await inspectEncryption(fixtureBytes('aes-256-r6')))!.info
    expect(toHex(await hashR6(utf8('user256'), info.U.subarray(32, 40)))).toBe(toHex(info.U.subarray(0, 32)))
    expect(toHex(await hashR6(utf8('owner256'), info.O.subarray(32, 40), info.U.subarray(0, 48)))).toBe(toHex(info.O.subarray(0, 32)))
  })
})

describe('password handling', () => {
  it('SASLprep (RFC 4013): maps spaces, drops soft hyphens, normalises with NFKC, keeps prohibited input as is', () => {
    expect(saslPrep(' x')).toBe(' x')
    expect(saslPrep('a­b')).toBe('ab')
    expect(saslPrep('ﬁ')).toBe('fi')
    expect(saslPrep('Ⅸ')).toBe('IX')
    expect(saslPrep('é')).toBe('é')
    expect(saslPrep('a\u0007b')).toBe('a\u0007b')
    expect(saslPrep('plain')).toBe('plain')
  })

  it('R6 passwords are UTF-8 truncated to 127 bytes', () => {
    expect(passwordBytesR6('é'.repeat(200))).toHaveLength(127)
    expect(passwordBytesR6('a'.repeat(200))).toHaveLength(127)
    expect(passwordBytesR6('€')).toEqual(utf8('€'))
    expect(passwordBytesR6('')).toHaveLength(0)
  })

  it('AES-256: a 200-character password works with any text sharing its first 127 bytes; 126 is not enough', async () => {
    const plain = await randomDoc(mulberry32(5))
    const enc = await protectBytes(plain, { algorithm: 'aes256', userPassword: 'a'.repeat(200), ownerPassword: 'own', P: -4, encryptMetadata: true })
    const info = (await inspectEncryption(enc))!.info
    expect(await authenticate(info, 'a'.repeat(200))).not.toBeNull()
    expect(await authenticate(info, 'a'.repeat(127) + 'DIFFERENT')).not.toBeNull()
    expect(await authenticate(info, 'a'.repeat(126))).toBeNull()
  })

  it('AES-256: canonically equivalent Unicode spellings open the same document (NFKC), other text does not', async () => {
    const plain = await randomDoc(mulberry32(6))
    const enc = await protectBytes(plain, { algorithm: 'aes256', userPassword: 'café€', ownerPassword: 'own', P: -4, encryptMetadata: true })
    const info = (await inspectEncryption(enc))!.info
    expect(await authenticate(info, 'café€')).not.toBeNull()
    expect(await authenticate(info, 'café€')).not.toBeNull()
    expect(await authenticate(info, 'cafe€')).toBeNull()
  })

  it('R<=4: Latin-1 letters are one byte each; the legacy limit is 32 bytes; text outside Latin-1 falls back to UTF-8', async () => {
    expect(passwordCandidatesLegacy('ä')[0]).toEqual(Uint8Array.from([0xe4]))
    expect(passwordCandidatesLegacy('ä')[1]).toEqual(Uint8Array.from([0xc3, 0xa4]))
    expect(passwordCandidatesLegacy('€')).toHaveLength(1)
    const plain = await randomDoc(mulberry32(7))
    for (const alg of ['aes128', 'rc4-128'] as Algorithm[]) {
      const enc = await protectBytes(plain, { algorithm: alg, userPassword: 'pässö€', ownerPassword: 'oü', P: -4, encryptMetadata: true })
      const info = (await inspectEncryption(enc))!.info
      expect(await authenticate(info, 'pässö€')).not.toBeNull()
      expect(await authenticate(info, 'pässö')).toBeNull()
      const long = await protectBytes(plain, { algorithm: alg, userPassword: 'z'.repeat(40), ownerPassword: 'o', P: -4, encryptMetadata: true })
      const li = (await inspectEncryption(long))!.info
      expect(await authenticate(li, 'z'.repeat(32))).not.toBeNull() // only the first 32 bytes count
      expect(await authenticate(li, 'z'.repeat(31))).toBeNull()
    }
  })

  it('PDF.js opens files with a Latin-1 password (R3 and R4)', async () => {
    const plain = await randomDoc(mulberry32(8))
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    for (const alg of ['aes128', 'rc4-128'] as Algorithm[]) {
      const enc = await protectBytes(plain, { algorithm: alg, userPassword: 'pässö', ownerPassword: 'oü', P: -4, encryptMetadata: true })
      const task = pdfjs.getDocument({ data: enc.slice(), password: 'pässö', verbosity: 0 })
      const doc = await task.promise
      expect(doc.numPages).toBeGreaterThan(0)
      await task.destroy()
    }
  })
})

describe('permissions (/P)', () => {
  it('every combination round-trips and produces a spec-conformant /P', () => {
    let n = 0
    for (const print of ['none', 'low', 'high'] as const) {
      for (let bits = 0; bits < 64; bits++) {
        const p: Permissions = { print, copy: !!(bits & 1), edit: !!(bits & 2), annotate: !!(bits & 4), fillForms: !!(bits & 8), assemble: !!(bits & 16), accessibility: !!(bits & 32) }
        const P = permissionsToP(p)
        expect(pToPermissions(P, 3)).toEqual(p)
        expect(pToPermissions(P, 6)).toEqual(p)
        expect(hasBit(P, 1) || hasBit(P, 2)).toBe(false) // reserved: 0
        expect(hasBit(P, 7) && hasBit(P, 8)).toBe(true) // reserved: 1
        for (let b = 13; b <= 32; b++) expect(hasBit(P, b), `bit ${b}`).toBe(true)
        expect(Number.isInteger(P) && P >= -2147483648 && P <= 2147483647).toBe(true)
        n++
      }
    }
    expect(n).toBe(192)
  })

  it('all permissions is -4, like qpdf and Acrobat', () => {
    expect(permissionsToP(ALL_PERMISSIONS)).toBe(-4)
  })

  it('revision 2 only has print/modify/copy/annotate bits; the rest follow their implied meaning', () => {
    const P = permissionsToP({ print: 'high', copy: false, edit: true, annotate: false, fillForms: true, assemble: true, accessibility: true })
    const p = pToPermissions(P, 2)
    expect(p.print).toBe('high')
    expect(p.copy).toBe(false)
    expect(p.edit).toBe(true)
    expect(p.annotate).toBe(false)
    expect(p.accessibility).toBe(true)
    expect(pToPermissions(permissionsToP({ ...ALL_PERMISSIONS, print: 'low' }), 2).print).toBe('high') // R2 printing is all or nothing
  })

  it('unused helper guard', () => {
    expect(equalBytes(concat(fromHex('01'), fromHex('02')), fromHex('0102'))).toBe(true)
  })
})
