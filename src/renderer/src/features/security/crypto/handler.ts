/**
 * The PDF standard security handler (ISO 32000-1 7.6, ISO 32000-2 7.6): key derivation, password authentication
 * and object-level encryption for revisions 2 to 6. Pure functions over bytes: no PDF objects, no DOM.
 *
 *   R2  RC4-40             V1     MD5
 *   R3  RC4 40..128        V2     MD5 (+50 rounds), 20-round RC4 for /O and /U
 *   R4  RC4 or AES-128     V4     crypt filters (V2 = RC4, AESV2 = AES-128), per-object keys via MD5
 *   R5  AES-256            V5     SHA-256 (Adobe extension level 3, deprecated but still found in the wild)
 *   R6  AES-256            V5     Algorithm 2.B (PDF 2.0)
 */
import type { Algorithm } from '@shared/features/security'
import { aesPdfDecrypt, aesPdfEncrypt, cbcDecryptRaw, cbcEncryptRaw, ecbDecryptBlock, ecbEncryptBlock } from './aes'
import { concat, equalBytes, fromLatin1, randomBytes, utf8 } from './bytes'
import { hashR5, hashR6 } from './hash'
import { md5 } from './md5'
import { rc4 } from './rc4'

export type CryptMethod = 'None' | 'RC4' | 'AESV2' | 'AESV3'

export class UnsupportedEncryptionError extends Error {}

export interface EncryptionInfo {
  V: number
  R: number
  /** File encryption key length in bits (40 to 256). */
  keyBits: number
  /** /P as a signed 32-bit integer. */
  P: number
  O: Uint8Array
  U: Uint8Array
  OE?: Uint8Array
  UE?: Uint8Array
  Perms?: Uint8Array
  encryptMetadata: boolean
  /** First element of the trailer /ID (empty if the file has none). */
  id0: Uint8Array
  /** Default methods for streams / strings (V4 and V5 name a crypt filter for each, V1-V3 always use RC4). */
  stmMethod: CryptMethod
  strMethod: CryptMethod
  /** The named crypt filters of a V4/V5 document (`Identity` is implicit). */
  cryptFilters: Record<string, CryptMethod>
  stmFilterName: string
  strFilterName: string
}

export interface Access {
  /** Which password opened the document. The owner has every permission whatever /P says. */
  kind: 'user' | 'owner'
  /** The file encryption key. */
  key: Uint8Array
  /**
   * The permissions to enforce (signed 32-bit, like /P). R2-R4 bind /P into the key, so it is /P itself. For R5/R6 it
   * comes from the encrypted /Perms block, which /P cannot be changed without: a /P that disagrees with it is ignored,
   * and a missing or undecryptable /Perms block means view-only.
   */
  P: number
  /** False if /P or /EncryptMetadata disagree with the /Perms block, or that block is missing or damaged (R5/R6). */
  permsIntact: boolean
}

/** Permissions of a document whose /Perms block cannot be trusted: nothing but viewing (all reserved bits set). */
export const VIEW_ONLY_P = 0xfffff0c0 | 0

/** The 32-byte padding string of Algorithm 2 (step a). */
const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a
])

const padPassword = (pw: Uint8Array): Uint8Array => concat(pw.subarray(0, 32), PAD).subarray(0, 32)

const le32 = (v: number): Uint8Array => Uint8Array.from([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255])

/** Number of key bytes the legacy (R2-R4) algorithms use. */
export const legacyKeyBytes = (info: Pick<EncryptionInfo, 'R' | 'keyBits'>): number => (info.R === 2 ? 5 : Math.min(16, Math.max(5, info.keyBits >> 3)))

// ---------------------------------------------------------------------------------------------------------------
// Password encoding

/**
 * SASLprep (RFC 4013) as revision 6 requires: map spaces and "nothing" characters, NFKC-normalise. Strings with
 * prohibited characters are returned unchanged, which is what other readers do.
 */
export function saslPrep(pw: string): string {
  // eslint-disable-next-line no-misleading-character-class
  const mappedToNothing = /[­͏᠆᠋-᠍​-‍⁠︀-️﻿]/g
  const nonAsciiSpace = /[   -   　]/g
  const mapped = pw.replace(mappedToNothing, '').replace(nonAsciiSpace, ' ')
  const out = mapped.normalize('NFKC')
  // Prohibited output: control characters, private use, surrogates, non-characters, tagging and separators.
  // eslint-disable-next-line no-control-regex, no-misleading-character-class
  if (/[\u0000-\u001f\u007f-\u009f۝܏᠎‎‏‪-‮⁡-⁣⁪-⁯￹-￿-\ud800-\udfff]/.test(out)) return pw
  return out
}

/** Password bytes for revision 5/6: UTF-8 of the SASLprep'd string, truncated to 127 bytes. */
export const passwordBytesR6 = (pw: string): Uint8Array => utf8(saslPrep(pw)).slice(0, 127)

/** Candidate byte encodings of a password for revisions 2-4 (Latin-1 first, then UTF-8 as some producers use). */
export function passwordCandidatesLegacy(pw: string): Uint8Array[] {
  const out: Uint8Array[] = []
  if ([...pw].every((c) => c.charCodeAt(0) < 256)) out.push(fromLatin1(pw))
  const u = utf8(pw)
  if (!out.some((o) => equalBytes(o, u))) out.push(u)
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Revisions 2-4

/** Algorithm 2: the file encryption key from a (user) password. */
export function legacyFileKey(info: EncryptionInfo, passwordBytes: Uint8Array): Uint8Array {
  const parts = [padPassword(passwordBytes), info.O.subarray(0, 32), le32(info.P), info.id0]
  if (info.R >= 4 && !info.encryptMetadata) parts.push(Uint8Array.from([0xff, 0xff, 0xff, 0xff]))
  const n = legacyKeyBytes(info)
  let h = md5(concat(...parts))
  if (info.R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n))
  return h.slice(0, n)
}

const xorKey = (key: Uint8Array, i: number): Uint8Array => key.map((b) => b ^ i)

/** Algorithms 4 and 5: the /U value for a file key (R2: 32 bytes; R3+: 16 significant bytes + 16 padding bytes). */
export function legacyUserEntry(info: Pick<EncryptionInfo, 'R' | 'id0'>, key: Uint8Array): Uint8Array {
  if (info.R === 2) return rc4(key, PAD)
  let x = rc4(key, md5(concat(PAD, info.id0)))
  for (let i = 1; i <= 19; i++) x = rc4(xorKey(key, i), x)
  return concat(x, new Uint8Array(16))
}

function checkLegacyUser(info: EncryptionInfo, key: Uint8Array): boolean {
  const expected = legacyUserEntry(info, key)
  const n = info.R === 2 ? 32 : 16
  return equalBytes(expected.subarray(0, n), info.U.subarray(0, n))
}

/** Algorithm 3 step a-d: the RC4 key derived from the owner password. */
function legacyOwnerKey(R: number, keyBytes: number, ownerPassword: Uint8Array): Uint8Array {
  let h = md5(padPassword(ownerPassword))
  if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h)
  return h.slice(0, R === 2 ? 5 : keyBytes)
}

/** Algorithm 3: the /O entry. */
export function legacyOwnerEntry(R: number, keyBytes: number, ownerPassword: Uint8Array, userPassword: Uint8Array): Uint8Array {
  const ok = legacyOwnerKey(R, keyBytes, ownerPassword)
  let x = rc4(ok, padPassword(userPassword))
  if (R >= 3) for (let i = 1; i <= 19; i++) x = rc4(xorKey(ok, i), x)
  return x
}

export function legacyAuthenticate(info: EncryptionInfo, passwordBytes: Uint8Array): Access | null {
  // Owner password (Algorithm 7): recover the user password from /O, then authenticate as that user.
  const ok = legacyOwnerKey(info.R, legacyKeyBytes(info), passwordBytes)
  let t = info.O.subarray(0, 32)
  if (info.R === 2) t = rc4(ok, t)
  else for (let i = 19; i >= 0; i--) t = rc4(xorKey(ok, i), t)
  const viaOwner = legacyFileKey(info, t)
  // /P is part of the key derivation: a changed /P gives a key that fails the check below.
  if (checkLegacyUser(info, viaOwner)) return { kind: 'owner', key: viaOwner, P: info.P | 0, permsIntact: true }
  // User password (Algorithm 6).
  const key = legacyFileKey(info, passwordBytes)
  if (checkLegacyUser(info, key)) return { kind: 'user', key, P: info.P | 0, permsIntact: true }
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// Revisions 5 and 6

const ZERO_IV = new Uint8Array(16)

const hashFor = (R: number) => (R === 5 ? hashR5 : hashR6)

export async function modernAuthenticate(info: EncryptionInfo, passwordBytes: Uint8Array): Promise<Access | null> {
  const hash = hashFor(info.R)
  const u48 = info.U.subarray(0, 48)
  if (info.O.length >= 48 && info.OE && equalBytes(await hash(passwordBytes, info.O.subarray(32, 40), u48), info.O.subarray(0, 32))) {
    const ik = await hash(passwordBytes, info.O.subarray(40, 48), u48)
    return withPermissions(info, 'owner', cbcDecryptRaw(ik, ZERO_IV, info.OE.subarray(0, 32)))
  }
  if (info.U.length >= 48 && info.UE && equalBytes(await hash(passwordBytes, info.U.subarray(32, 40)), info.U.subarray(0, 32))) {
    const ik = await hash(passwordBytes, info.U.subarray(40, 48))
    return withPermissions(info, 'user', cbcDecryptRaw(ik, ZERO_IV, info.UE.subarray(0, 32)))
  }
  return null
}

/** The decrypted /Perms block (Algorithm 2.A step h), or null if it is missing or does not carry the 'adb' marker. */
function readPerms(info: EncryptionInfo, key: Uint8Array): { P: number; encryptMetadata: boolean | null } | null {
  if (!info.Perms || info.Perms.length < 16) return null
  const b = ecbDecryptBlock(key, info.Perms.subarray(0, 16))
  if (b[9] !== 0x61 || b[10] !== 0x64 || b[11] !== 0x62) return null
  const meta = b[8] === 0x54 ? true : b[8] === 0x46 ? false : null // 'T' / 'F'
  return { P: b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24), encryptMetadata: meta }
}

/** R5/R6: the permissions come from /Perms, which is encrypted with the file key and so cannot be edited like /P. */
function withPermissions(info: EncryptionInfo, kind: Access['kind'], key: Uint8Array): Access {
  const perms = readPerms(info, key)
  if (!perms || perms.encryptMetadata !== info.encryptMetadata) return { kind, key, P: VIEW_ONLY_P, permsIntact: false }
  return { kind, key, P: perms.P, permsIntact: perms.P === (info.P | 0) }
}

/** /Perms check (Algorithm 2.A step h): does the permission block decrypt to something that matches /P? */
export function permsMatch(info: EncryptionInfo, key: Uint8Array): boolean {
  const perms = readPerms(info, key)
  return !!perms && perms.P === (info.P | 0)
}

// ---------------------------------------------------------------------------------------------------------------
// Authentication entry point

/**
 * Tries `password` as the owner password and then as the user password. Returns the access (kind + file key), or
 * null if it is neither. Wrong passwords return null quickly for R<=4 and after one hash for R5/6: no oracle is
 * needed beyond "right or wrong", and the work does not depend on how much of the password matched.
 */
export async function authenticate(info: EncryptionInfo, password: string): Promise<Access | null> {
  if (info.R >= 5) {
    const candidates = [passwordBytesR6(password)]
    const raw = utf8(password).slice(0, 127)
    if (!equalBytes(raw, candidates[0])) candidates.push(raw)
    for (const c of candidates) {
      const a = await modernAuthenticate(info, c)
      if (a) return a
    }
    return null
  }
  for (const c of passwordCandidatesLegacy(password)) {
    const a = legacyAuthenticate(info, c)
    if (a) return a
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// Object-level encryption

/** Algorithm 1 / 1.A: the key for one object (R5/6 use the file key directly). */
export function objectKey(fileKey: Uint8Array, objNum: number, gen: number, method: CryptMethod): Uint8Array {
  if (method === 'AESV3') return fileKey
  const tail = Uint8Array.from([objNum & 255, (objNum >>> 8) & 255, (objNum >>> 16) & 255, gen & 255, (gen >>> 8) & 255])
  const parts = [fileKey, tail]
  if (method === 'AESV2') parts.push(Uint8Array.from([0x73, 0x41, 0x6c, 0x54])) // "sAlT"
  return md5(concat(...parts)).slice(0, Math.min(fileKey.length + 5, 16))
}

export function decryptBytes(method: CryptMethod, fileKey: Uint8Array, objNum: number, gen: number, data: Uint8Array): Uint8Array {
  if (method === 'None') return data
  const key = objectKey(fileKey, objNum, gen, method)
  return method === 'RC4' ? rc4(key, data) : aesPdfDecrypt(key, data)
}

export function encryptBytes(method: CryptMethod, fileKey: Uint8Array, objNum: number, gen: number, data: Uint8Array, iv?: Uint8Array): Uint8Array {
  if (method === 'None') return data
  const key = objectKey(fileKey, objNum, gen, method)
  return method === 'RC4' ? rc4(key, data) : aesPdfEncrypt(key, data, iv)
}

// ---------------------------------------------------------------------------------------------------------------
// Creating a protection

export interface NewProtection {
  algorithm: Algorithm
  /** Empty string = no password needed to open. */
  userPassword: string
  /** Empty string = a random password nobody knows is generated (so only the user password can open the file). */
  ownerPassword: string
  /** /P (signed 32-bit). */
  P: number
  encryptMetadata: boolean
  /** First trailer ID element to use (a fresh random one if omitted). */
  id0?: Uint8Array
}

export interface Protection {
  info: EncryptionInfo
  /** The file encryption key. Kept in memory only. */
  key: Uint8Array
}

const randomPassword = (): Uint8Array => randomBytes(24)

/** Builds every /Encrypt entry (and the file key) for new protection settings. */
export async function createProtection(opts: NewProtection): Promise<Protection> {
  const id0 = opts.id0 ?? randomBytes(16)
  const P = opts.P | 0
  if (opts.algorithm === 'aes256') {
    const key = randomBytes(32)
    const user = passwordBytesR6(opts.userPassword)
    const owner = opts.ownerPassword ? passwordBytesR6(opts.ownerPassword) : randomPassword()
    const uvs = randomBytes(8)
    const uks = randomBytes(8)
    const U = concat(await hashR6(user, uvs), uvs, uks)
    const UE = cbcEncryptRaw(await hashR6(user, uks), ZERO_IV, key)
    const ovs = randomBytes(8)
    const oks = randomBytes(8)
    const O = concat(await hashR6(owner, ovs, U), ovs, oks)
    const OE = cbcEncryptRaw(await hashR6(owner, oks, U), ZERO_IV, key)
    const perms = new Uint8Array(16)
    perms.set(le32(P), 0)
    perms.set([0xff, 0xff, 0xff, 0xff], 4)
    perms[8] = opts.encryptMetadata ? 0x54 : 0x46 // 'T' / 'F'
    perms.set([0x61, 0x64, 0x62], 9) // 'adb'
    perms.set(randomBytes(4), 12)
    return {
      key,
      info: {
        V: 5,
        R: 6,
        keyBits: 256,
        P,
        O,
        U,
        OE,
        UE,
        Perms: ecbEncryptBlock(key, perms),
        encryptMetadata: opts.encryptMetadata,
        id0,
        stmMethod: 'AESV3',
        strMethod: 'AESV3',
        cryptFilters: { StdCF: 'AESV3' },
        stmFilterName: 'StdCF',
        strFilterName: 'StdCF'
      }
    }
  }

  const aes = opts.algorithm === 'aes128'
  const base: EncryptionInfo = {
    V: aes ? 4 : 2,
    R: aes ? 4 : 3,
    keyBits: 128,
    P,
    O: new Uint8Array(32),
    U: new Uint8Array(32),
    // Only revision 4 has the /EncryptMetadata switch.
    encryptMetadata: aes ? opts.encryptMetadata : true,
    id0,
    stmMethod: aes ? 'AESV2' : 'RC4',
    strMethod: aes ? 'AESV2' : 'RC4',
    cryptFilters: aes ? { StdCF: 'AESV2' } : {},
    stmFilterName: aes ? 'StdCF' : 'Identity',
    strFilterName: aes ? 'StdCF' : 'Identity'
  }
  const user = passwordCandidatesLegacy(opts.userPassword)[0]
  const owner = opts.ownerPassword ? passwordCandidatesLegacy(opts.ownerPassword)[0] : randomPassword()
  base.O = legacyOwnerEntry(base.R, 16, owner, user)
  const key = legacyFileKey(base, user)
  base.U = legacyUserEntry(base, key)
  return { info: base, key }
}

/** Short human description of the algorithm ("AES-256 (revision 6)", "AES-128", "RC4 40-bit"). */
export const describeAlgorithm = (info: Pick<EncryptionInfo, 'V' | 'R' | 'keyBits' | 'stmMethod'>): string => {
  if (info.R >= 5) return `AES-256 (revision ${info.R})`
  if (info.stmMethod === 'AESV2') return 'AES-128'
  return `RC4 ${info.keyBits}-bit`
}
