import { describe, expect, it } from 'vitest'
import { ALL_PERMISSIONS, permissionsToP, ProtectSettingsSchema } from '@shared/features/security'
import { inspectEncryption } from '../../src/renderer/src/features/security/crypto/document'
import { ALGORITHM_CHOICES, DEFAULT_SETTINGS, algorithmOf, describeProtection, isAllowed, mayEdit } from '../../src/renderer/src/features/security/logic'
import { fixtureBytes } from './helpers/securityHelpers'

const info = async (name: string) => (await inspectEncryption(fixtureBytes(name)))!.info

describe('what a password level may do', () => {
  const NONE = permissionsToP({ print: 'none', copy: false, edit: false, annotate: false, fillForms: false, assemble: false, accessibility: true })

  it('the owner can always edit, print and copy; a user only what /P allows', () => {
    expect(mayEdit('owner', NONE)).toBe(true)
    expect(mayEdit('user', NONE)).toBe(false)
    expect(mayEdit('user', permissionsToP({ ...ALL_PERMISSIONS }))).toBe(true)
    expect(mayEdit('user', permissionsToP({ ...ALL_PERMISSIONS, edit: false, annotate: true }))).toBe(false) // strict: content editing needs the modify bit
    expect(isAllowed({ kind: 'owner', P: NONE, R: 6 }, 'print')).toBe(true)
    expect(isAllowed({ kind: 'user', P: NONE, R: 6 }, 'print')).toBe(false)
    expect(isAllowed({ kind: 'user', P: NONE, R: 6 }, 'copy')).toBe(false)
    expect(isAllowed({ kind: 'user', P: permissionsToP({ ...ALL_PERMISSIONS, print: 'low' }), R: 6 }, 'print')).toBe(true)
    expect(isAllowed({ kind: 'user', P: permissionsToP({ ...ALL_PERMISSIONS, copy: false }), R: 3 }, 'copy')).toBe(false)
  })

  it('an unknown access level (document never probed) is not restricted', () => {
    expect(isAllowed(undefined, 'print')).toBe(true)
    expect(isAllowed(undefined, 'copy')).toBe(true)
  })
})

describe('defaults and choices for the protect dialog', () => {
  it('AES-256 first and by default; all permissions on; the settings satisfy their schema', () => {
    expect(DEFAULT_SETTINGS.algorithm).toBe('aes256')
    expect(ALGORITHM_CHOICES.map((c) => c.value)).toEqual(['aes256', 'aes128', 'rc4-128'])
    expect(ALGORITHM_CHOICES[0].label).toMatch(/recommended/)
    expect(ALGORITHM_CHOICES[2].label).toMatch(/weak/)
    expect(ProtectSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, userPassword: 'x' }).success).toBe(true)
    expect(ProtectSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, algorithm: 'des' }).success).toBe(false)
    expect(ProtectSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, userPassword: 'x'.repeat(300) }).success).toBe(false)
  })

  it('the algorithm of an existing file maps back to a choice', async () => {
    expect(algorithmOf(await info('aes-256-r6'))).toBe('aes256')
    expect(algorithmOf(await info('aes-256-r5'))).toBe('aes256')
    expect(algorithmOf(await info('aes-128'))).toBe('aes128')
    expect(algorithmOf(await info('rc4-128'))).toBe('rc4-128')
    expect(algorithmOf(await info('rc4-40'))).toBe('rc4-128')
  })
})

describe('the security info dialog content', () => {
  it('not protected', async () => {
    const d = await describeProtection('a.pdf', null)
    expect(d.protectedDoc).toBe(false)
    expect(d.summary).toContain('not password protected')
    expect(d.rows).toEqual([])
  })

  it('AES-256 file that needs a password: algorithm, key length, permissions, no open-without-password', async () => {
    const d = await describeProtection('a.pdf', await info('aes-256-r6'))
    const row = (l: string): string => d.rows.find((r) => r.label === l)!.value
    expect(row('Encryption')).toBe('AES-256 (revision 6)')
    expect(row('Key length')).toBe('256-bit')
    expect(row('Opens without a password')).toMatch(/^No/)
    expect(row('Metadata encrypted')).toBe('Yes')
    expect(d.permissions).toHaveLength(7)
    expect(d.permissions.every((p) => p.allowed)).toBe(true)
    expect(d.notes.join(' ')).toContain('Restrictions are honoured only by programs that choose to')
  })

  it('owner-only file opens with the empty password; user-only does not', async () => {
    const free = await describeProtection('a.pdf', await info('owner-only'))
    expect(free.rows.find((r) => r.label === 'Opens without a password')!.value).toMatch(/^Yes/)
    const locked = await describeProtection('a.pdf', await info('user-only'))
    expect(locked.rows.find((r) => r.label === 'Opens without a password')!.value).toMatch(/^No/)
  })

  it('lists each restriction and the weak-cipher / draft-revision / unsaved / access notes', async () => {
    const d = await describeProtection('a.pdf', await info('no-permissions-aes128'), { unsaved: true, access: { kind: 'user', P: 0, R: 4 } })
    const byLabel = Object.fromEntries(d.permissions.map((p) => [p.label, p]))
    expect(byLabel['Printing'].allowed).toBe(false)
    expect(byLabel['Printing'].detail).toBe('Not allowed')
    expect(byLabel['Copying text and images'].allowed).toBe(false)
    expect(byLabel['Accessibility extraction'].allowed).toBe(true)
    expect(d.rows.find((r) => r.label === 'Opened in this window with')!.value).toMatch(/user password/)
    expect(d.notes.some((n) => n.includes('unsaved changes'))).toBe(true)

    const rc4 = await describeProtection('a.pdf', await info('rc4-128'))
    expect(rc4.notes.some((n) => n.includes('RC4'))).toBe(true)
    const r5 = await describeProtection('a.pdf', await info('aes-256-r5'))
    expect(r5.notes.some((n) => n.includes('revision 5'))).toBe(true)
    const low = await describeProtection('a.pdf', await info('lowres-print-rc4-128'))
    expect(low.permissions.find((p) => p.label === 'Printing')!.detail).toBe('Low resolution only')
  })

  it('metadata-cleartext files say so', async () => {
    const d = await describeProtection('a.pdf', await info('cleartext-metadata-aes256'))
    expect(d.rows.find((r) => r.label === 'Metadata encrypted')!.value).toBe('No')
  })
})
