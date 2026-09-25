import { z } from 'zod'

/**
 * Contract between the renderer and main for saved visual signatures (channels `sign:*`).
 * The PNG is the only sensitive part: main stores it encrypted (Electron safeStorage) and only ever hands
 * it back to the renderer of the same user profile. Nothing here ever leaves the machine.
 */

export const MAX_SIGNATURES = 24
/** Hard cap on one PNG (a drawn signature is a few KB; an imported scan is downscaled before saving). */
export const MAX_SIGNATURE_BYTES = 1_500_000
export const MAX_SIGNATURE_DIMENSION = 2400

export const SignatureKindSchema = z.enum(['signature', 'initials'])
export type SignatureKind = z.infer<typeof SignatureKindSchema>

export const SignatureMethodSchema = z.enum(['draw', 'type', 'import'])
export type SignatureMethod = z.infer<typeof SignatureMethodSchema>

const PngBytes = z.custom<Uint8Array>((v) => v instanceof Uint8Array, 'Expected PNG bytes').refine(
  (b) => b.length > 0 && b.length <= MAX_SIGNATURE_BYTES,
  `The image must be between 1 byte and ${MAX_SIGNATURE_BYTES} bytes`
)

const dimension = z.number().int().min(1).max(MAX_SIGNATURE_DIMENSION)

export const SaveSignatureRequestSchema = z.object({
  name: z.string().trim().min(1, 'Give the signature a name').max(60),
  kind: SignatureKindSchema,
  method: SignatureMethodSchema,
  png: PngBytes,
  width: dimension,
  height: dimension
})
export type SaveSignatureRequest = z.infer<typeof SaveSignatureRequestSchema>

export const DeleteSignatureRequestSchema = z.object({ id: z.number().int().min(1) })
export const ListSignaturesRequestSchema = z.object({}).optional()

export interface SignatureRecord {
  id: number
  name: string
  kind: SignatureKind
  method: SignatureMethod
  width: number
  height: number
  createdAt: number
  /** Decrypted PNG (with alpha). */
  png: Uint8Array
}

export type SaveSignatureResult =
  | { ok: true; id: number }
  | { ok: false; code: 'encryption-unavailable' | 'rejected'; message: string }

export interface SignatureStatus {
  /** False when the OS cannot protect secrets (e.g. no keyring): saving is refused, never done in plain text. */
  encryptionAvailable: boolean
}

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** True if the bytes start with the PNG magic number (the only format we store). */
export function looksLikePng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}
