import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterAll, describe, expect, it } from 'vitest'
import { ALL_PERMISSIONS, permissionsToP, type Algorithm, type Permissions } from '@shared/features/security'
import { protectBytes, inspectEncryption } from '../../src/renderer/src/features/security/crypto/document'
import { authenticate, permsMatch, VIEW_ONLY_P, type Protection } from '../../src/renderer/src/features/security/crypto/handler'
import { toHex } from '../../src/renderer/src/features/security/crypto/bytes'
import { isAllowed, mayEdit } from '../../src/renderer/src/features/security/logic'
import { allStreamText, expectFixturePlaintext, fixtureBytes, openWith } from './helpers/securityHelpers'
import { assemble, encryptDictText, pageObjects, rawEncryption, showText, streamObject } from './helpers/rawPdf'
import { QPDF } from '../support/tools'

const haveQpdf = existsSync(QPDF)

const tmp = mkdtempSync(join(tmpdir(), 'epdf-sec-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const ALGS: Algorithm[] = ['aes256', 'aes128', 'rc4-128']
const NO_PERMS: Permissions = { print: 'none', copy: false, edit: false, annotate: false, fillForms: false, assemble: false, accessibility: false }

const protect = (alg: Algorithm, o: { user?: string; owner?: string; perms?: Permissions; meta?: boolean } = {}): Promise<Uint8Array> =>
  protectBytes(fixtureBytes('plain'), {
    algorithm: alg,
    userPassword: o.user ?? 'open sesame',
    ownerPassword: o.owner ?? 'boss',
    P: permissionsToP(o.perms ?? ALL_PERMISSIONS),
    encryptMetadata: o.meta ?? true
  })

const latin = (b: Uint8Array): string => Buffer.from(b).toString('latin1')

describe('files we encrypt: round trip through our own decryptor', () => {
  for (const alg of ALGS) {
    it(`${alg}: user and owner passwords open it and the content is intact`, async () => {
      const enc = await protect(alg)
      const u = await openWith(enc, 'open sesame')
      expect(u.access.kind).toBe('user')
      expect(await expectFixturePlaintext(u.plain)).toEqual([])
      const o = await openWith(enc, 'boss')
      expect(o.access.kind).toBe('owner')
      expect(await expectFixturePlaintext(o.plain)).toEqual([])
      const probe = (await inspectEncryption(enc))!
      expect(await authenticate(probe.info, 'nope')).toBeNull()
      expect(await authenticate(probe.info, '')).toBeNull()
    })

    it(`${alg}: nothing readable is left in the file`, async () => {
      const raw = latin(await protect(alg))
      for (const needle of ['Secret page', 'Security Fixture Title', 'Annotation note', 'XMP-MARKER-TITLE', 'fox jumps', 'Fixture Author']) {
        expect(raw.includes(needle), needle).toBe(false)
      }
      expect(raw).toContain('/Encrypt')
      expect(raw).toContain('/Standard')
      // The Info strings are encrypted hex strings, so the plain UTF-16 / ASCII forms must not appear either.
      expect(raw.includes('S\0e\0c\0u\0r')).toBe(false)
    })

    it(`${alg}: the empty user password (owner password only) opens without a prompt`, async () => {
      const enc = await protect(alg, { user: '', owner: 'boss' })
      const probe = (await inspectEncryption(enc))!
      expect((await authenticate(probe.info, ''))?.kind).toBe('user')
      expect((await authenticate(probe.info, 'boss'))?.kind).toBe('owner')
      expect(await expectFixturePlaintext((await openWith(enc, '')).plain)).toEqual([])
    })

    it(`${alg}: user password only (no owner password): a random owner password is used`, async () => {
      const enc = await protect(alg, { user: 'onlyme', owner: '' })
      const probe = (await inspectEncryption(enc))!
      expect((await authenticate(probe.info, 'onlyme'))?.kind).toBe('user')
      expect(await authenticate(probe.info, '')).toBeNull()
    })

    it(`${alg}: permissions are stored in /P`, async () => {
      const enc = await protect(alg, { perms: NO_PERMS })
      const probe = (await inspectEncryption(enc))!
      expect(probe.info.P).toBe(permissionsToP(NO_PERMS))
    })

    it(`${alg}: every encryption uses a fresh random IV / key (two runs differ, both decrypt)`, async () => {
      const a = await protect(alg)
      const b = await protect(alg)
      expect(latin(a)).not.toBe(latin(b))
      expect(await expectFixturePlaintext((await openWith(b, 'open sesame')).plain)).toEqual([])
    })
  }

  it('AES-256: the /Perms block we write decrypts to a block that matches /P (Algorithm 2.A step h); qpdf\'s does too', async () => {
    const ours = await openWith(await protect('aes256', { perms: NO_PERMS }), 'boss')
    expect(permsMatch(ours.info, ours.access.key)).toBe(true)
    const theirs = await openWith(fixtureBytes('aes-256-r6'), 'user256')
    expect(permsMatch(theirs.info, theirs.access.key)).toBe(true)
    // A wrong key or a changed /P fails the check.
    expect(permsMatch(ours.info, new Uint8Array(32))).toBe(false)
    expect(permsMatch({ ...ours.info, P: ours.info.P ^ 4 }, ours.access.key)).toBe(false)
  })

  describe('AES-256: the permissions come from /Perms, not from an editable /P', () => {
    const P_NONE = permissionsToP(NO_PERMS)
    const P_ALL = permissionsToP(ALL_PERMISSIONS)

    /** A one-page aes256 file whose /Encrypt dictionary is written from `tamper(info)`. */
    async function build(tamper: (info: Protection['info']) => Protection['info']): Promise<Uint8Array> {
      const enc = await rawEncryption({ algorithm: 'aes256', userPassword: 'uu', ownerPassword: 'oo', P: P_NONE, encryptMetadata: true })
      const dict = encryptDictText({ ...enc.protection, info: tamper({ ...enc.protection.info }) })
      const id = toHex(enc.protection.info.id0)
      return assemble(pageObjects(streamObject('', enc.stream(4, showText('Restricted text'))), [{ num: 8, body: dict }]), `/Root 1 0 R /Encrypt 8 0 R /ID [<${id}> <${id}>]`).bytes
    }

    it('untouched: /P and /Perms agree', async () => {
      const probe = (await inspectEncryption(await build((i) => i)))!
      const a = (await authenticate(probe.info, 'uu'))!
      expect(a.kind).toBe('user')
      expect(a.P).toBe(P_NONE)
      expect(a.permsIntact).toBe(true)
      expect(mayEdit(a.kind, a.P)).toBe(false)
    })

    it('a /P changed to allow everything is ignored: the restrictions in /Perms still apply', async () => {
      const bytes = await build((i) => ({ ...i, P: P_ALL }))
      const probe = (await inspectEncryption(bytes))!
      expect(probe.info.P).toBe(P_ALL) // what the file claims
      const a = (await authenticate(probe.info, 'uu'))!
      expect(a.kind).toBe('user')
      expect(a.P).toBe(P_NONE)
      expect(a.permsIntact).toBe(false)
      expect(mayEdit(a.kind, a.P)).toBe(false)
      expect(isAllowed({ kind: a.kind, P: a.P, R: probe.info.R }, 'print')).toBe(false)
      expect(isAllowed({ kind: a.kind, P: a.P, R: probe.info.R }, 'copy')).toBe(false)
      // The document still decrypts; the owner keeps every permission.
      expect(await allStreamText((await openWith(bytes, 'uu')).plain)).toContain('Restricted text')
      expect((await authenticate(probe.info, 'oo'))?.kind).toBe('owner')
    })

    it('a damaged or missing /Perms block, or an /EncryptMetadata that disagrees with it, means view-only', async () => {
      const cases: ((i: Protection['info']) => Protection['info'])[] = [
        (i) => ({ ...i, P: P_ALL, Perms: new Uint8Array(16).fill(7) }),
        (i) => ({ ...i, P: P_ALL, Perms: undefined }),
        (i) => ({ ...i, P: P_ALL, encryptMetadata: false })
      ]
      for (const tamper of cases) {
        const probe = (await inspectEncryption(await build(tamper)))!
        const a = (await authenticate(probe.info, 'uu'))!
        expect(a.kind).toBe('user')
        expect(a.P).toBe(VIEW_ONLY_P)
        expect(a.permsIntact).toBe(false)
        expect(mayEdit(a.kind, a.P)).toBe(false)
        expect(isAllowed({ kind: a.kind, P: a.P, R: probe.info.R }, 'print')).toBe(false)
        expect(isAllowed({ kind: a.kind, P: a.P, R: probe.info.R }, 'copy')).toBe(false)
      }
    })

    it('RC4 / AES-128: /P is bound into the key, so a changed /P no longer opens the file', async () => {
      for (const algorithm of ['aes128', 'rc4-128'] as Algorithm[]) {
        const enc = await rawEncryption({ algorithm, userPassword: 'uu', ownerPassword: 'oo', P: P_NONE, encryptMetadata: true })
        const ok = (await authenticate(enc.protection.info, 'uu'))!
        expect(ok.P).toBe(P_NONE)
        expect(ok.permsIntact).toBe(true)
        expect(await authenticate({ ...enc.protection.info, P: P_ALL }, 'uu')).toBeNull()
      }
    })
  })

  it('EncryptMetadata=false: the XMP stream stays readable, everything else is encrypted (AES-128 and AES-256)', async () => {
    for (const alg of ['aes128', 'aes256'] as Algorithm[]) {
      const enc = await protect(alg, { meta: false })
      const raw = latin(enc)
      expect(raw.includes('XMP-MARKER-TITLE'), alg).toBe(true)
      expect(raw.includes('Secret page')).toBe(false)
      const probe = (await inspectEncryption(enc))!
      expect(probe.info.encryptMetadata).toBe(false)
      expect(await expectFixturePlaintext((await openWith(enc, 'open sesame')).plain)).toEqual([])
    }
  })

  it('the output is a valid PDF pdf-lib can inspect after decryption, with a classic xref and an /ID', async () => {
    const enc = await protect('aes256')
    const raw = latin(enc)
    expect(raw.startsWith('%PDF-1.7')).toBe(true)
    expect(raw).toContain('/ExtensionLevel 8')
    expect(raw).toMatch(/\/ID\s*\[\s*<[0-9a-f]{32}>\s*<[0-9a-f]{32}>\s*\]/)
    expect(raw).toContain('xref')
    const { plain } = await openWith(enc, 'boss')
    expect((await PDFDocument.load(plain)).getPageCount()).toBe(3)
  })

  it('protecting an already-protected copy is stable: decrypt then protect with new settings', async () => {
    const first = await protect('rc4-128', { user: 'one' })
    const { plain } = await openWith(first, 'one')
    const second = await protectBytes(plain, { algorithm: 'aes256', userPassword: 'two', ownerPassword: 'own2', P: permissionsToP(NO_PERMS), encryptMetadata: true })
    expect(await expectFixturePlaintext((await openWith(second, 'two')).plain)).toEqual([])
    const probe = (await inspectEncryption(second))!
    expect(await authenticate(probe.info, 'one')).toBeNull()
  })
})

describe('files we encrypt: accepted by PDF.js (an independent reader)', () => {
  async function pdfjsOpen(bytes: Uint8Array, password?: string): Promise<{ text: string; permissions: number[] | null; pages: number; title: string }> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = pdfjs.getDocument({ data: bytes.slice(), password, verbosity: 0, useSystemFonts: false, disableFontFace: true })
    const doc = await task.promise
    try {
      let text = ''
      for (let i = 1; i <= doc.numPages; i++) {
        const tc = await (await doc.getPage(i)).getTextContent()
        text += (tc.items as { str?: string }[]).map((t) => t.str ?? '').join(' ') + '\n'
      }
      const meta = await doc.getMetadata()
      return { text, permissions: (await doc.getPermissions()) as number[] | null, pages: doc.numPages, title: (meta.info as { Title?: string }).Title ?? '' }
    } finally {
      await task.destroy()
    }
  }

  for (const alg of ALGS) {
    it(`${alg}: opens with the user password and with the owner password`, async () => {
      const enc = await protect(alg)
      for (const pw of ['open sesame', 'boss']) {
        const r = await pdfjsOpen(enc, pw)
        expect(r.pages).toBe(3)
        expect(r.text).toContain('Secret page 1')
        expect(r.text).toContain('Secret page 3')
        expect(r.text).toContain('The quick brown fox')
        expect(r.title).toBe('Security Fixture Title')
      }
    })

    it(`${alg}: PDF.js rejects a wrong password and asks for one when none is given`, async () => {
      const enc = await protect(alg)
      await expect(pdfjsOpen(enc, 'wrong')).rejects.toMatchObject({ name: 'PasswordException', code: 2 })
      await expect(pdfjsOpen(enc)).rejects.toMatchObject({ name: 'PasswordException', code: 1 })
    })
  }

  it('an empty user password opens directly in PDF.js', async () => {
    for (const alg of ALGS) {
      const r = await pdfjsOpen(await protect(alg, { user: '', owner: 'boss' }))
      expect(r.text).toContain('Secret page 2')
    }
  })

  it('PDF.js reports the permission flags we wrote', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const F = pdfjs.PermissionFlag
    const perms: Permissions = { print: 'low', copy: false, edit: false, annotate: true, fillForms: false, assemble: true, accessibility: true }
    for (const alg of ALGS) {
      const r = await pdfjsOpen(await protect(alg, { perms }), 'open sesame')
      const got = new Set(r.permissions)
      expect(got.has(F.PRINT), alg).toBe(true)
      expect(got.has(F.COPY), alg).toBe(false)
      expect(got.has(F.MODIFY_CONTENTS), alg).toBe(false)
      expect(got.has(F.MODIFY_ANNOTATIONS), alg).toBe(true)
      expect(got.has(F.FILL_INTERACTIVE_FORMS), alg).toBe(false)
      expect(got.has(F.ASSEMBLE), alg).toBe(true)
      expect(got.has(F.PRINT_HIGH_QUALITY), alg).toBe(false)
    }
  })

  it('metadata-cleartext AES-256 opens too', async () => {
    const r = await pdfjsOpen(await protect('aes256', { meta: false }), 'boss')
    expect(r.text).toContain('Secret page 1')
  })
})

describe.skipIf(!haveQpdf)('files we encrypt: verified by qpdf (independent implementation; optional, dev machine only)', () => {
  const run = (args: string[]): string => {
    try {
      return execFileSync(QPDF, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number }
      throw new Error(`qpdf ${args.join(' ')} failed (${e.status}): ${e.stdout}${e.stderr}`)
    }
  }
  const write = (name: string, b: Uint8Array): string => {
    const p = join(tmp, name)
    writeFileSync(p, b)
    return p
  }

  for (const alg of ALGS) {
    it(`${alg}: qpdf --check passes with the user and owner passwords`, async () => {
      const f = write(`${alg}.pdf`, await protect(alg))
      for (const pw of ['open sesame', 'boss']) {
        const out = run([`--password=${pw}`, '--check', f])
        expect(out).toContain('No syntax or stream encoding errors found')
      }
    })

    it(`${alg}: qpdf --show-encryption reports the algorithm, key and permission bits`, async () => {
      const perms: Permissions = { print: 'low', copy: false, edit: false, annotate: true, fillForms: true, assemble: false, accessibility: true }
      const f = write(`${alg}-perm.pdf`, await protect(alg, { perms }))
      const out = run(['--password=open sesame', '--show-encryption', f])
      if (alg === 'aes256') {
        expect(out).toContain('R = 6')
        expect(out).toContain('file encryption method: AESv3')
      } else if (alg === 'aes128') {
        expect(out).toContain('R = 4')
        expect(out).toContain('file encryption method: AESv2')
      } else {
        expect(out).toContain('R = 3')
        expect(out).toMatch(/Supplied password is user password/)
      }
      expect(out).toMatch(/print low resolution: allowed/)
      expect(out).toMatch(/print high resolution: not allowed/)
      expect(out).toMatch(/extract for any purpose: not allowed/)
      expect(out).toMatch(/modify annotations: allowed/)
      expect(out).toMatch(/modify forms: allowed/)
      expect(out).toMatch(/modify document assembly: not allowed/)
      expect(out).toMatch(/modify other: not allowed/)
      expect(run(['--password=boss', '--show-encryption', f])).toMatch(/Supplied password is owner password/)
    })

    it(`${alg}: qpdf decrypts our file to the same text`, async () => {
      const f = write(`${alg}-dec.pdf`, await protect(alg))
      const out = join(tmp, `${alg}-dec-out.pdf`)
      run(['--password=open sesame', '--decrypt', f, out])
      const { readFileSync } = await import('node:fs')
      const problems = await expectFixturePlaintext(new Uint8Array(readFileSync(out)))
      expect(problems).toEqual([])
    })
  }

  it('qpdf agrees on EncryptMetadata=false', async () => {
    const f = write('nometa.pdf', await protect('aes128', { meta: false }))
    expect(run(['--password=boss', '--check', f])).toContain('No syntax or stream encoding errors found')
    expect(run(['--password=boss', '--show-encryption', f])).toMatch(/extract for accessibility: allowed/)
  })

  it('qpdf rejects a wrong password on our file (so it really is encrypted with the passwords we set)', async () => {
    const f = write('wrongpw.pdf', await protect('aes256'))
    expect(() => run(['--password=wrong', '--check', f])).toThrow(/invalid password/i)
  })
})
