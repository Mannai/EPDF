import { z } from 'zod'

/**
 * Types and pure helpers for the Security feature that both the renderer UI and the crypto layer use:
 * the friendly permission model and its mapping to the /P bit field of the PDF standard security handler.
 */

/** Which encryption a document is (or will be) written with. */
export type Algorithm = 'aes256' | 'aes128' | 'rc4-128'

export const ALGORITHM_LABEL: Record<Algorithm, string> = {
  aes256: 'AES-256 (recommended)',
  aes128: 'AES-128 (compatibility)',
  'rc4-128': 'RC4-128 (legacy compatibility, weak)'
}

export type PrintPermission = 'none' | 'low' | 'high'

export interface Permissions {
  print: PrintPermission
  /** Copy or extract text and images. */
  copy: boolean
  /** Modify the content of the document. */
  edit: boolean
  /** Add or change annotations (comments). */
  annotate: boolean
  /** Fill in existing form fields (and sign). */
  fillForms: boolean
  /** Insert, delete, rotate pages and create bookmarks/thumbnails. */
  assemble: boolean
  /** Extract text/images for accessibility (screen readers). */
  accessibility: boolean
}

export const ALL_PERMISSIONS: Permissions = {
  print: 'high',
  copy: true,
  edit: true,
  annotate: true,
  fillForms: true,
  assemble: true,
  accessibility: true
}

/** Bits of /P (1-based, as in the PDF specification). */
export const P_BIT = { print: 3, modify: 4, copy: 5, annotate: 6, fillForms: 9, accessibility: 10, assemble: 11, printHigh: 12 } as const

const bit = (n: number): number => 2 ** (n - 1)

/** True if bit `n` (1-based) of the 32-bit two's complement value `p` is set. */
export const hasBit = (p: number, n: number): boolean => ((p | 0) & bit(n)) !== 0

/**
 * The /P value for these permissions, as a signed 32-bit integer. Reserved bits follow the specification:
 * bits 1-2 are 0, bits 7-8 and 13-32 are 1.
 */
export function permissionsToP(perm: Permissions): number {
  let p = 0xfffff0c0 // bits 7, 8 and 13..32
  if (perm.print !== 'none') p |= bit(P_BIT.print)
  if (perm.print === 'high') p |= bit(P_BIT.printHigh)
  if (perm.edit) p |= bit(P_BIT.modify)
  if (perm.copy) p |= bit(P_BIT.copy)
  if (perm.annotate) p |= bit(P_BIT.annotate)
  if (perm.fillForms) p |= bit(P_BIT.fillForms)
  if (perm.accessibility) p |= bit(P_BIT.accessibility)
  if (perm.assemble) p |= bit(P_BIT.assemble)
  return p | 0
}

/**
 * Reads /P. For revision 2 the bits for form filling, accessibility, assembly and high-quality printing do not
 * exist: printing is then all-or-nothing and the remaining ones follow the specification's implied defaults.
 */
export function pToPermissions(pRaw: number, revision: number): Permissions {
  const p = pRaw | 0
  if (revision <= 2) {
    return {
      print: hasBit(p, P_BIT.print) ? 'high' : 'none',
      copy: hasBit(p, P_BIT.copy),
      edit: hasBit(p, P_BIT.modify),
      annotate: hasBit(p, P_BIT.annotate),
      fillForms: hasBit(p, P_BIT.annotate),
      accessibility: true,
      assemble: hasBit(p, P_BIT.modify)
    }
  }
  return {
    print: !hasBit(p, P_BIT.print) ? 'none' : hasBit(p, P_BIT.printHigh) ? 'high' : 'low',
    copy: hasBit(p, P_BIT.copy),
    edit: hasBit(p, P_BIT.modify),
    annotate: hasBit(p, P_BIT.annotate),
    fillForms: hasBit(p, P_BIT.fillForms),
    accessibility: hasBit(p, P_BIT.accessibility),
    assemble: hasBit(p, P_BIT.assemble)
  }
}

export const PermissionsSchema = z.object({
  print: z.enum(['none', 'low', 'high']),
  copy: z.boolean(),
  edit: z.boolean(),
  annotate: z.boolean(),
  fillForms: z.boolean(),
  assemble: z.boolean(),
  accessibility: z.boolean()
})

/** What the "Protect with Password" dialog produces. */
export const ProtectSettingsSchema = z.object({
  algorithm: z.enum(['aes256', 'aes128', 'rc4-128']),
  /** Password needed to open the document ('' = anyone can open it). */
  userPassword: z.string().max(256),
  /** Password needed to change the restrictions ('' = none chosen: a random one nobody knows is used). */
  ownerPassword: z.string().max(256),
  permissions: PermissionsSchema,
  /** Encrypt the XMP metadata stream too (default true). */
  encryptMetadata: z.boolean().default(true)
})
export type ProtectSettings = z.infer<typeof ProtectSettingsSchema>

export const isRestricted = (p: Permissions): boolean => Object.entries(ALL_PERMISSIONS).some(([k, v]) => p[k as keyof Permissions] !== v)

/** Human-readable rows for the permission list (used by the info dialog). */
export function describePermissions(p: Permissions): { label: string; allowed: boolean; detail: string }[] {
  return [
    { label: 'Printing', allowed: p.print !== 'none', detail: p.print === 'high' ? 'High resolution' : p.print === 'low' ? 'Low resolution only' : 'Not allowed' },
    { label: 'Copying text and images', allowed: p.copy, detail: p.copy ? 'Allowed' : 'Not allowed' },
    { label: 'Editing content', allowed: p.edit, detail: p.edit ? 'Allowed' : 'Not allowed' },
    { label: 'Adding comments (annotations)', allowed: p.annotate, detail: p.annotate ? 'Allowed' : 'Not allowed' },
    { label: 'Filling in form fields', allowed: p.fillForms, detail: p.fillForms ? 'Allowed' : 'Not allowed' },
    { label: 'Page assembly (insert, delete, rotate)', allowed: p.assemble, detail: p.assemble ? 'Allowed' : 'Not allowed' },
    { label: 'Accessibility extraction', allowed: p.accessibility, detail: p.accessibility ? 'Allowed' : 'Not allowed' }
  ]
}
