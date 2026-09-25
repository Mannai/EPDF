import { ALL_PERMISSIONS, ALGORITHM_LABEL, P_BIT, describePermissions, hasBit, pToPermissions, type Algorithm, type ProtectSettings } from '@shared/features/security'
import { authenticate, describeAlgorithm, type EncryptionInfo } from './crypto/handler'

/**
 * Pure decisions of the Security feature (no stores, no PDF.js): what a password level may do, the defaults of the
 * protect dialog, and the content of the info dialog. Kept apart from `session.ts` so they can be unit-tested in Node.
 */

/** Which password level opened a document in this window, and the /P it was opened with. */
export interface DocAccess {
  kind: 'user' | 'owner'
  P: number
  R: number
}

export interface InfoRow {
  label: string
  value: string
}

export interface SecurityInfo {
  fileName: string
  protectedDoc: boolean
  /** Short headline, e.g. "This document is password protected." */
  summary: string
  rows: InfoRow[]
  permissions: { label: string; allowed: boolean; detail: string }[]
  /** Extra explanation lines (unsaved state, weak cipher, advisory permissions, ...). */
  notes: string[]
}

/** Editing needs the "modify content" permission unless the owner password was used. */
export const mayEdit = (kind: 'user' | 'owner', P: number): boolean => kind === 'owner' || hasBit(P, P_BIT.modify)

export type Restricted = 'print' | 'copy'

/** True unless the document was opened with a user password whose permissions forbid `what`. */
export function isAllowed(access: DocAccess | undefined, what: Restricted): boolean {
  if (!access || access.kind === 'owner') return true
  return hasBit(access.P, what === 'print' ? P_BIT.print : P_BIT.copy)
}

export function algorithmOf(info: Pick<EncryptionInfo, 'R' | 'stmMethod'>): Algorithm {
  return info.R >= 5 ? 'aes256' : info.stmMethod === 'AESV2' ? 'aes128' : 'rc4-128'
}

export const DEFAULT_SETTINGS: ProtectSettings = {
  algorithm: 'aes256',
  userPassword: '',
  ownerPassword: '',
  permissions: { ...ALL_PERMISSIONS },
  encryptMetadata: true
}

export const ALGORITHM_CHOICES: { value: Algorithm; label: string }[] = (['aes256', 'aes128', 'rc4-128'] as Algorithm[]).map((value) => ({
  value,
  label: ALGORITHM_LABEL[value]
}))

const yesNo = (b: boolean): string => (b ? 'Yes' : 'No')

/** What the read-only "Document Security" dialog shows for a document's protection (null = not protected). */
export async function describeProtection(
  fileName: string,
  info: EncryptionInfo | null,
  opts: { unsaved?: boolean; access?: DocAccess } = {}
): Promise<SecurityInfo> {
  if (!info) {
    return { fileName, protectedDoc: false, summary: 'This document is not password protected.', rows: [], permissions: [], notes: [] }
  }
  const perms = pToPermissions(info.P, info.R)
  const opensFree = !!(await authenticate(info, ''))
  const notes: string[] = []
  if (opts.unsaved) {
    notes.push('This is the protection the document has in Epdf now, with unsaved changes. It is written to the file when you save; the file on disk may still have different settings.')
  }
  if (info.stmMethod === 'RC4') notes.push('RC4 is an old cipher with known weaknesses. Use AES-256 unless an old reader needs to open the file.')
  if (info.R === 5) notes.push('This file uses an early draft of AES-256 (revision 5) that is deprecated. Protect it again to upgrade it to revision 6.')
  notes.push('Restrictions are honoured only by programs that choose to. The password to open is what actually keeps the content private.')
  const rows: InfoRow[] = [
    { label: 'Encryption', value: describeAlgorithm(info) },
    { label: 'Key length', value: `${info.keyBits}-bit` },
    { label: 'Security handler', value: `Standard (version ${info.V}, revision ${info.R})` },
    { label: 'Opens without a password', value: opensFree ? 'Yes: the password to open is empty' : 'No: a password is required' },
    { label: 'Metadata encrypted', value: yesNo(info.encryptMetadata) }
  ]
  if (opts.access) {
    rows.push({
      label: 'Opened in this window with',
      value: opts.access.kind === 'owner' ? 'The owner password (all permissions)' : 'A user password (restricted by the permissions below)'
    })
  }
  return {
    fileName,
    protectedDoc: true,
    summary: opensFree && perms.print === 'high' && perms.copy && perms.edit ? 'Protected: the password only restricts changes.' : 'This document is password protected.',
    rows,
    permissions: describePermissions(perms),
    notes
  }
}
