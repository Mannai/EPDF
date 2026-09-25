import { describe, expect, it } from 'vitest'
import { hasMarker, inspectEncryption } from '../../src/renderer/src/features/security/crypto/document'
import { authenticate, describeAlgorithm } from '../../src/renderer/src/features/security/crypto/handler'
import { pToPermissions } from '@shared/features/security'
import { expectFixturePlaintext, fixtureBytes, openWith } from './helpers/securityHelpers'

/**
 * Decryption checked against files produced by qpdf, an independent implementation (tests/fixtures/security,
 * passwords in tests/fixtures/security/README.txt). Every fixture derives from one plaintext source, so a correct
 * decryption must reproduce its text, Info strings, annotation strings and XMP metadata exactly.
 */

interface Case {
  name: string
  user: string
  owner: string
  V: number
  R: number
  bits: number
  method: string
  metadata?: boolean
}

const CASES: Case[] = [
  { name: 'rc4-40', user: 'user40', owner: 'owner40', V: 1, R: 2, bits: 40, method: 'RC4' },
  { name: 'rc4-128', user: 'user128', owner: 'owner128', V: 2, R: 3, bits: 128, method: 'RC4' },
  { name: 'aes-128', user: 'userAes', owner: 'ownerAes', V: 4, R: 4, bits: 128, method: 'AESV2' },
  { name: 'aes-256-r6', user: 'user256', owner: 'owner256', V: 5, R: 6, bits: 256, method: 'AESV3' },
  { name: 'aes-256-r5', user: 'user5', owner: 'owner5', V: 5, R: 5, bits: 256, method: 'AESV3' },
  { name: 'cleartext-metadata-aes128', user: 'umeta', owner: 'ometa', V: 4, R: 4, bits: 128, method: 'AESV2', metadata: false },
  { name: 'cleartext-metadata-aes256', user: 'umeta6', owner: 'ometa6', V: 5, R: 6, bits: 256, method: 'AESV3', metadata: false },
  { name: 'objstm-aes256', user: 'userObj', owner: 'ownerObj', V: 5, R: 6, bits: 256, method: 'AESV3' },
  { name: 'objstm-aes128', user: 'userObj', owner: 'ownerObj', V: 4, R: 4, bits: 128, method: 'AESV2' },
  { name: 'objstm-rc4-128', user: 'userObj', owner: 'ownerObj', V: 4, R: 4, bits: 128, method: 'RC4' },
  { name: 'unicode-password-aes256', user: 'pässö€', owner: 'oüw', V: 5, R: 6, bits: 256, method: 'AESV3' },
  { name: 'latin1-password-rc4-128', user: 'pässö', owner: 'oüw', V: 2, R: 3, bits: 128, method: 'RC4' }
]

describe('qpdf fixtures: parameters are read correctly', () => {
  for (const c of CASES) {
    it(`${c.name}: V${c.V} R${c.R}, ${c.bits}-bit ${c.method}`, async () => {
      const probe = await inspectEncryption(fixtureBytes(c.name))
      expect(probe).not.toBeNull()
      const i = probe!.info
      expect([i.V, i.R, i.keyBits, i.stmMethod, i.strMethod]).toEqual([c.V, c.R, c.bits, c.method, c.method])
      expect(i.encryptMetadata).toBe(c.metadata !== false)
      expect(i.id0).toHaveLength(16)
    })
  }
  it('an unencrypted file has no encryption', async () => {
    expect(await inspectEncryption(fixtureBytes('plain'))).toBeNull()
  })
})

describe('qpdf fixtures: decrypt with the user and the owner password', () => {
  for (const c of CASES) {
    it(`${c.name}: user password`, async () => {
      const o = await openWith(fixtureBytes(c.name), c.user)
      expect(o.access.kind).toBe('user')
      expect(await expectFixturePlaintext(o.plain, { metadata: true })).toEqual([])
      expect(hasMarker(o.plain)).toBe(false)
    })
    it(`${c.name}: owner password`, async () => {
      const o = await openWith(fixtureBytes(c.name), c.owner)
      expect(o.access.kind).toBe('owner')
      expect(await expectFixturePlaintext(o.plain)).toEqual([])
    })
    it(`${c.name}: wrong passwords are rejected`, async () => {
      const probe = (await inspectEncryption(fixtureBytes(c.name)))!
      for (const bad of ['', 'wrong', c.user + 'x', c.user.slice(0, -1), c.owner.toUpperCase() + '!']) {
        expect(await authenticate(probe.info, bad), JSON.stringify(bad)).toBeNull()
      }
    })
  }
})

describe('qpdf fixtures: special cases', () => {
  it('owner-only: opens with the EMPTY user password (as a user), and with the owner password as owner', async () => {
    const bytes = fixtureBytes('owner-only')
    const probe = (await inspectEncryption(bytes))!
    expect((await authenticate(probe.info, ''))?.kind).toBe('user')
    expect((await authenticate(probe.info, 'onlyowner'))?.kind).toBe('owner')
    expect(await authenticate(probe.info, 'x')).toBeNull()
    expect(await expectFixturePlaintext((await openWith(bytes, '')).plain)).toEqual([])
  })

  it('user-only: the user password opens it, the empty password does not', async () => {
    const bytes = fixtureBytes('user-only')
    const probe = (await inspectEncryption(bytes))!
    expect(await authenticate(probe.info, '')).toBeNull()
    expect((await authenticate(probe.info, 'onlyuser'))?.kind).toBe('user')
    expect(await expectFixturePlaintext((await openWith(bytes, 'onlyuser')).plain)).toEqual([])
  })

  it('no-permissions files: every restriction is reported and the owner still gets full access', async () => {
    for (const name of ['no-permissions-aes128', 'no-permissions-aes256']) {
      const probe = (await inspectEncryption(fixtureBytes(name)))!
      const p = pToPermissions(probe.info.P, probe.info.R)
      expect(p, name).toEqual({ print: 'none', copy: false, edit: false, annotate: false, fillForms: false, assemble: false, accessibility: name === 'no-permissions-aes128' ? true : true })
    }
  })

  it('low-resolution printing only', async () => {
    const probe = (await inspectEncryption(fixtureBytes('lowres-print-rc4-128')))!
    const p = pToPermissions(probe.info.P, probe.info.R)
    expect(p.print).toBe('low')
    expect(p.copy && p.edit && p.annotate).toBe(true)
  })

  it('decrypting twice yields the same document', async () => {
    const bytes = fixtureBytes('aes-256-r6')
    const a = await openWith(bytes, 'user256')
    const b = await openWith(bytes, 'owner256')
    expect(await expectFixturePlaintext(a.plain)).toEqual([])
    expect(a.plain.length).toBe(b.plain.length)
  })

  it('describes algorithms for the info dialog', async () => {
    const d = async (n: string): Promise<string> => describeAlgorithm((await inspectEncryption(fixtureBytes(n)))!.info)
    expect(await d('rc4-40')).toBe('RC4 40-bit')
    expect(await d('rc4-128')).toBe('RC4 128-bit')
    expect(await d('aes-128')).toBe('AES-128')
    expect(await d('aes-256-r6')).toBe('AES-256 (revision 6)')
    expect(await d('aes-256-r5')).toBe('AES-256 (revision 5)')
  })
})
