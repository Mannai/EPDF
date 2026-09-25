/**
 * AES-128/256 in pure TypeScript (FIPS-197) with CBC helpers. Synchronous on purpose: PDF encryption applies AES
 * to thousands of tiny strings and per-object keys, where a WebCrypto round trip per string would be far slower.
 * Large streams go through WebCrypto (see webAes.ts); tests cross-check the two implementations.
 */
import { concat, randomBytes } from './bytes'

const SBOX = new Uint8Array(256)
const INV_SBOX = new Uint8Array(256)
const TE = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
const TD = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]

const xtime = (x: number): number => ((x << 1) ^ (x & 0x80 ? 0x11b : 0)) & 0xff
function gmul(a: number, b: number): number {
  let r = 0
  while (b) {
    if (b & 1) r ^= a
    a = xtime(a)
    b >>= 1
  }
  return r
}

;(function init() {
  let p = 1
  let q = 1
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x11b : 0)) & 0xff // p *= 3
    q = (q ^ (q << 1)) & 0xff // q /= 3
    q = (q ^ (q << 2)) & 0xff
    q = (q ^ (q << 4)) & 0xff
    if (q & 0x80) q ^= 0x09
    const rot = (x: number, n: number): number => ((x << n) | (x >> (8 - n))) & 0xff
    SBOX[p] = (q ^ rot(q, 1) ^ rot(q, 2) ^ rot(q, 3) ^ rot(q, 4) ^ 0x63) & 0xff
  } while (p !== 1)
  SBOX[0] = 0x63
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i]
    const s2 = xtime(s)
    const s3 = s2 ^ s
    const t = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0
    TE[0][i] = t
    TE[1][i] = ((t >>> 8) | (t << 24)) >>> 0
    TE[2][i] = ((t >>> 16) | (t << 16)) >>> 0
    TE[3][i] = ((t >>> 24) | (t << 8)) >>> 0
    const si = INV_SBOX[i]
    const d = ((gmul(si, 14) << 24) | (gmul(si, 9) << 16) | (gmul(si, 13) << 8) | gmul(si, 11)) >>> 0
    TD[0][i] = d
    TD[1][i] = ((d >>> 8) | (d << 24)) >>> 0
    TD[2][i] = ((d >>> 16) | (d << 16)) >>> 0
    TD[3][i] = ((d >>> 24) | (d << 8)) >>> 0
  }
})()

const be32 = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
const putBe32 = (b: Uint8Array, o: number, v: number): void => {
  b[o] = v >>> 24
  b[o + 1] = v >>> 16
  b[o + 2] = v >>> 8
  b[o + 3] = v
}
const subWord = (w: number): number => ((SBOX[w >>> 24] << 24) | (SBOX[(w >>> 16) & 255] << 16) | (SBOX[(w >>> 8) & 255] << 8) | SBOX[w & 255]) >>> 0

export class Aes {
  readonly rounds: number
  private readonly ek: Uint32Array
  private readonly dk: Uint32Array

  constructor(key: Uint8Array) {
    if (key.length !== 16 && key.length !== 32 && key.length !== 24) throw new Error('AES key must be 16, 24 or 32 bytes')
    const nk = key.length / 4
    this.rounds = nk + 6
    const total = 4 * (this.rounds + 1)
    const w = new Uint32Array(total)
    for (let i = 0; i < nk; i++) w[i] = be32(key, i * 4)
    let rcon = 1
    for (let i = nk; i < total; i++) {
      let t = w[i - 1]
      if (i % nk === 0) {
        t = (subWord(((t << 8) | (t >>> 24)) >>> 0) ^ ((rcon << 24) >>> 0)) >>> 0
        rcon = xtime(rcon)
      } else if (nk > 6 && i % nk === 4) t = subWord(t)
      w[i] = (w[i - nk] ^ t) >>> 0
    }
    this.ek = w
    // Decryption key schedule for the "equivalent inverse cipher": reversed rounds, InvMixColumns on the middle ones.
    const dk = new Uint32Array(total)
    for (let r = 0; r <= this.rounds; r++) {
      for (let c = 0; c < 4; c++) {
        let v = w[(this.rounds - r) * 4 + c]
        if (r > 0 && r < this.rounds) {
          v = (TD[0][SBOX[v >>> 24]] ^ TD[1][SBOX[(v >>> 16) & 255]] ^ TD[2][SBOX[(v >>> 8) & 255]] ^ TD[3][SBOX[v & 255]]) >>> 0
        }
        dk[r * 4 + c] = v
      }
    }
    this.dk = dk
  }

  /** Encrypts the 16-byte block `src[so..]` into `dst[do..]` (may be the same array). */
  encryptBlock(src: Uint8Array, so: number, dst: Uint8Array, dof: number): void {
    const k = this.ek
    let s0 = (be32(src, so) ^ k[0]) >>> 0
    let s1 = (be32(src, so + 4) ^ k[1]) >>> 0
    let s2 = (be32(src, so + 8) ^ k[2]) >>> 0
    let s3 = (be32(src, so + 12) ^ k[3]) >>> 0
    let ki = 4
    for (let r = 1; r < this.rounds; r++) {
      const t0 = TE[0][s0 >>> 24] ^ TE[1][(s1 >>> 16) & 255] ^ TE[2][(s2 >>> 8) & 255] ^ TE[3][s3 & 255] ^ k[ki]
      const t1 = TE[0][s1 >>> 24] ^ TE[1][(s2 >>> 16) & 255] ^ TE[2][(s3 >>> 8) & 255] ^ TE[3][s0 & 255] ^ k[ki + 1]
      const t2 = TE[0][s2 >>> 24] ^ TE[1][(s3 >>> 16) & 255] ^ TE[2][(s0 >>> 8) & 255] ^ TE[3][s1 & 255] ^ k[ki + 2]
      const t3 = TE[0][s3 >>> 24] ^ TE[1][(s0 >>> 16) & 255] ^ TE[2][(s1 >>> 8) & 255] ^ TE[3][s2 & 255] ^ k[ki + 3]
      s0 = t0 >>> 0
      s1 = t1 >>> 0
      s2 = t2 >>> 0
      s3 = t3 >>> 0
      ki += 4
    }
    putBe32(dst, dof, (((SBOX[s0 >>> 24] << 24) | (SBOX[(s1 >>> 16) & 255] << 16) | (SBOX[(s2 >>> 8) & 255] << 8) | SBOX[s3 & 255]) ^ k[ki]) >>> 0)
    putBe32(dst, dof + 4, (((SBOX[s1 >>> 24] << 24) | (SBOX[(s2 >>> 16) & 255] << 16) | (SBOX[(s3 >>> 8) & 255] << 8) | SBOX[s0 & 255]) ^ k[ki + 1]) >>> 0)
    putBe32(dst, dof + 8, (((SBOX[s2 >>> 24] << 24) | (SBOX[(s3 >>> 16) & 255] << 16) | (SBOX[(s0 >>> 8) & 255] << 8) | SBOX[s1 & 255]) ^ k[ki + 2]) >>> 0)
    putBe32(dst, dof + 12, (((SBOX[s3 >>> 24] << 24) | (SBOX[(s0 >>> 16) & 255] << 16) | (SBOX[(s1 >>> 8) & 255] << 8) | SBOX[s2 & 255]) ^ k[ki + 3]) >>> 0)
  }

  decryptBlock(src: Uint8Array, so: number, dst: Uint8Array, dof: number): void {
    const k = this.dk
    let s0 = (be32(src, so) ^ k[0]) >>> 0
    let s1 = (be32(src, so + 4) ^ k[1]) >>> 0
    let s2 = (be32(src, so + 8) ^ k[2]) >>> 0
    let s3 = (be32(src, so + 12) ^ k[3]) >>> 0
    let ki = 4
    for (let r = 1; r < this.rounds; r++) {
      const t0 = TD[0][s0 >>> 24] ^ TD[1][(s3 >>> 16) & 255] ^ TD[2][(s2 >>> 8) & 255] ^ TD[3][s1 & 255] ^ k[ki]
      const t1 = TD[0][s1 >>> 24] ^ TD[1][(s0 >>> 16) & 255] ^ TD[2][(s3 >>> 8) & 255] ^ TD[3][s2 & 255] ^ k[ki + 1]
      const t2 = TD[0][s2 >>> 24] ^ TD[1][(s1 >>> 16) & 255] ^ TD[2][(s0 >>> 8) & 255] ^ TD[3][s3 & 255] ^ k[ki + 2]
      const t3 = TD[0][s3 >>> 24] ^ TD[1][(s2 >>> 16) & 255] ^ TD[2][(s1 >>> 8) & 255] ^ TD[3][s0 & 255] ^ k[ki + 3]
      s0 = t0 >>> 0
      s1 = t1 >>> 0
      s2 = t2 >>> 0
      s3 = t3 >>> 0
      ki += 4
    }
    putBe32(dst, dof, (((INV_SBOX[s0 >>> 24] << 24) | (INV_SBOX[(s3 >>> 16) & 255] << 16) | (INV_SBOX[(s2 >>> 8) & 255] << 8) | INV_SBOX[s1 & 255]) ^ k[ki]) >>> 0)
    putBe32(dst, dof + 4, (((INV_SBOX[s1 >>> 24] << 24) | (INV_SBOX[(s0 >>> 16) & 255] << 16) | (INV_SBOX[(s3 >>> 8) & 255] << 8) | INV_SBOX[s2 & 255]) ^ k[ki + 1]) >>> 0)
    putBe32(dst, dof + 8, (((INV_SBOX[s2 >>> 24] << 24) | (INV_SBOX[(s1 >>> 16) & 255] << 16) | (INV_SBOX[(s0 >>> 8) & 255] << 8) | INV_SBOX[s3 & 255]) ^ k[ki + 2]) >>> 0)
    putBe32(dst, dof + 12, (((INV_SBOX[s3 >>> 24] << 24) | (INV_SBOX[(s2 >>> 16) & 255] << 16) | (INV_SBOX[(s1 >>> 8) & 255] << 8) | INV_SBOX[s0 & 255]) ^ k[ki + 3]) >>> 0)
  }
}

/** CBC-encrypts `data` (a multiple of 16 bytes, NO padding added) with the given IV. */
export function cbcEncryptRaw(key: Uint8Array | Aes, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length % 16) throw new Error('CBC input must be a multiple of 16 bytes')
  const aes = key instanceof Aes ? key : new Aes(key)
  const out = new Uint8Array(data.length)
  const blk = new Uint8Array(16)
  let prev = iv
  let prevOff = 0
  for (let o = 0; o < data.length; o += 16) {
    for (let i = 0; i < 16; i++) blk[i] = data[o + i] ^ prev[prevOff + i]
    aes.encryptBlock(blk, 0, out, o)
    prev = out
    prevOff = o
  }
  return out
}

/** CBC-decrypts a range of `data` (multiple of 16) into `out`; `prev` supplies the block before `start`. */
export function cbcDecryptRange(aes: Aes, prev: Uint8Array, prevOff: number, data: Uint8Array, out: Uint8Array, start: number, end: number): void {
  for (let o = start; o < end; o += 16) {
    aes.decryptBlock(data, o, out, o)
    for (let i = 0; i < 16; i++) out[o + i] ^= prev[prevOff + i]
    prev = data
    prevOff = o
  }
}

/** CBC-decrypts `data` (a multiple of 16 bytes, NO padding removed) with the given IV. */
export function cbcDecryptRaw(key: Uint8Array | Aes, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length % 16) throw new Error('CBC input must be a multiple of 16 bytes')
  const aes = key instanceof Aes ? key : new Aes(key)
  const out = new Uint8Array(data.length)
  cbcDecryptRange(aes, iv, 0, data, out, 0, data.length)
  return out
}

export const ecbEncryptBlock = (key: Uint8Array, block: Uint8Array): Uint8Array => {
  const out = new Uint8Array(16)
  new Aes(key).encryptBlock(block, 0, out, 0)
  return out
}

export const ecbDecryptBlock = (key: Uint8Array, block: Uint8Array): Uint8Array => {
  const out = new Uint8Array(16)
  new Aes(key).decryptBlock(block, 0, out, 0)
  return out
}

/** PKCS#5/#7 padding as used by PDF: always adds 1-16 bytes. */
export function pkcs7Pad(data: Uint8Array): Uint8Array {
  const pad = 16 - (data.length % 16)
  const out = new Uint8Array(data.length + pad)
  out.set(data)
  out.fill(pad, data.length)
  return out
}

/**
 * Removes PKCS#7 padding tolerantly: real-world files sometimes carry damaged padding, and refusing to show a
 * document over it would be worse than keeping the bytes (as other readers do).
 */
export function pkcs7UnpadLenient(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data
  const pad = data[data.length - 1]
  if (pad < 1 || pad > 16 || pad > data.length) return data
  return data.subarray(0, data.length - pad)
}

/** The PDF form of an AES-CBC encrypted string/stream: a random 16 byte IV followed by the padded ciphertext. */
export function aesPdfEncrypt(key: Uint8Array | Aes, data: Uint8Array, iv: Uint8Array = randomBytes(16)): Uint8Array {
  return concat(iv, cbcEncryptRaw(key, iv, pkcs7Pad(data)))
}

/** Inverse of `aesPdfEncrypt`. Input shorter than 32 bytes (no IV + one block) decrypts to nothing. */
export function aesPdfDecrypt(key: Uint8Array | Aes, data: Uint8Array): Uint8Array {
  if (data.length < 32) return new Uint8Array(0)
  const usable = data.length - (data.length % 16)
  const aes = key instanceof Aes ? key : new Aes(key)
  const out = new Uint8Array(usable) // decrypted bytes land at the same offsets as the ciphertext; block 0 is the IV
  cbcDecryptRange(aes, data, 0, data, out, 16, usable)
  return pkcs7UnpadLenient(out.subarray(16))
}
