/**
 * Encryption/decryption of whole strings and streams for the object-level layer. Small inputs use the synchronous
 * pure-TypeScript ciphers; big streams use WebCrypto's AES (native, off the UI thread) or, for RC4, are processed in
 * slices that yield to the event loop, so protecting a 100 MB document does not freeze the window.
 */
import { Aes, aesPdfDecrypt, aesPdfEncrypt, cbcEncryptRaw, pkcs7UnpadLenient } from './aes'
import { concat, randomBytes, yieldToEventLoop } from './bytes'
import { objectKey, type CryptMethod } from './handler'
import { Rc4 } from './rc4'

/** Streams at least this big go through the asynchronous paths. */
export const BULK_THRESHOLD = 512 * 1024
const RC4_SLICE = 4 * 1024 * 1024

const subtle = (): SubtleCrypto => globalThis.crypto.subtle

/** AES-CBC decrypt of `iv || ciphertext` with WebCrypto. WebCrypto insists on valid padding, so we append a block that supplies it. */
export async function webAesDecrypt(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 32) return new Uint8Array(0)
  const usable = data.length - (data.length % 16)
  const iv = data.subarray(0, 16)
  const ct = data.subarray(16, usable)
  // E_k(0x10*16 xor lastBlock) with IV = lastBlock is the block that decrypts (after chaining) to sixteen 0x10 bytes.
  const padBlock = cbcEncryptRaw(new Aes(key), ct.subarray(ct.length - 16), new Uint8Array(16).fill(16))
  const k = await subtle().importKey('raw', key as BufferSource, 'AES-CBC', false, ['decrypt'])
  const out = new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, k, concat(ct, padBlock) as BufferSource))
  return pkcs7UnpadLenient(out)
}

/** AES-CBC encrypt with WebCrypto (PKCS#7 padded); returns `iv || ciphertext` like `aesPdfEncrypt`. */
export async function webAesEncrypt(key: Uint8Array, data: Uint8Array, iv: Uint8Array = randomBytes(16)): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', key as BufferSource, 'AES-CBC', false, ['encrypt'])
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv: iv as BufferSource }, k, data as BufferSource))
  return concat(iv, ct)
}

export async function decryptStream(method: CryptMethod, fileKey: Uint8Array, objNum: number, gen: number, data: Uint8Array): Promise<Uint8Array> {
  if (method === 'None') return data
  const key = objectKey(fileKey, objNum, gen, method)
  if (method === 'RC4') return rc4Sliced(key, data)
  return data.length >= BULK_THRESHOLD ? webAesDecrypt(key, data) : aesPdfDecrypt(key, data)
}

export async function encryptStream(method: CryptMethod, fileKey: Uint8Array, objNum: number, gen: number, data: Uint8Array): Promise<Uint8Array> {
  if (method === 'None') return data
  const key = objectKey(fileKey, objNum, gen, method)
  if (method === 'RC4') return rc4Sliced(key, data)
  return data.length >= BULK_THRESHOLD ? webAesEncrypt(key, data) : aesPdfEncrypt(key, data)
}

async function rc4Sliced(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const out = data.slice()
  const c = new Rc4(key)
  for (let o = 0; o < out.length; o += RC4_SLICE) {
    c.applyInPlace(out, o, Math.min(out.length, o + RC4_SLICE))
    if (out.length > RC4_SLICE) await yieldToEventLoop()
  }
  return out
}
