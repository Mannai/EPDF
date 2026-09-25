import { cbcEncryptRaw } from './aes'
import { concat } from './bytes'

/**
 * SHA-2 through WebCrypto (available in the renderer and in Node 20+), and the revision 5/6 password hashes.
 * `digest` wants a BufferSource; our Uint8Arrays are always backed by a plain ArrayBuffer, so the casts are safe.
 */
const digest = async (alg: 'SHA-256' | 'SHA-384' | 'SHA-512', data: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await globalThis.crypto.subtle.digest(alg, data as BufferSource))

export const sha256 = (d: Uint8Array): Promise<Uint8Array> => digest('SHA-256', d)
export const sha384 = (d: Uint8Array): Promise<Uint8Array> => digest('SHA-384', d)
export const sha512 = (d: Uint8Array): Promise<Uint8Array> => digest('SHA-512', d)

/** Revision 5 (Adobe Extension Level 3, deprecated): plain SHA-256. */
export const hashR5 = (password: Uint8Array, salt: Uint8Array, udata: Uint8Array = new Uint8Array(0)): Promise<Uint8Array> =>
  sha256(concat(password, salt, udata))

/**
 * Revision 6 (PDF 2.0) hash, "Algorithm 2.B": an iterated SHA-256/384/512 mix where each round also runs AES-128-CBC over
 * 64 copies of (password + K + user data). At least 64 rounds; it stops once the last byte of the AES output is small
 * enough for the round count. Returns 32 bytes.
 */
export async function hashR6(password: Uint8Array, salt: Uint8Array, udata: Uint8Array = new Uint8Array(0)): Promise<Uint8Array> {
  let k = await sha256(concat(password, salt, udata))
  let round = 0
  for (;;) {
    round++
    const unit = concat(password, k, udata)
    const k1 = new Uint8Array(unit.length * 64)
    for (let i = 0; i < 64; i++) k1.set(unit, i * unit.length)
    const e = cbcEncryptRaw(k.subarray(0, 16), k.subarray(16, 32), k1)
    // The first 16 bytes as a big-endian number modulo 3 (256 = 1 mod 3, so it is just the byte sum modulo 3).
    let sum = 0
    for (let i = 0; i < 16; i++) sum += e[i]
    const m = sum % 3
    k = m === 0 ? await sha256(e) : m === 1 ? await sha384(e) : await sha512(e)
    if (round >= 64 && e[e.length - 1] <= round - 32) break
  }
  return k.subarray(0, 32)
}
