import { describe, expect, it } from 'vitest'
import { Aes, aesPdfDecrypt, aesPdfEncrypt, cbcDecryptRaw, cbcEncryptRaw, ecbDecryptBlock, ecbEncryptBlock, pkcs7Pad, pkcs7UnpadLenient } from '../../src/renderer/src/features/security/crypto/aes'
import { concat, fromHex, fromLatin1, toHex, utf8 } from '../../src/renderer/src/features/security/crypto/bytes'
import { md5 } from '../../src/renderer/src/features/security/crypto/md5'
import { rc4 } from '../../src/renderer/src/features/security/crypto/rc4'

/** Published test vectors: RFC 1321 (MD5), the RC4 vectors from Wikipedia/RFC 6229 style, FIPS-197 and NIST SP 800-38A (AES). */

describe('MD5 (RFC 1321 test suite)', () => {
  const cases: [string, string][] = [
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
    ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a']
  ]
  for (const [input, hex] of cases) it(`md5(${JSON.stringify(input.slice(0, 20))}…)`, () => expect(toHex(md5(utf8(input)))).toBe(hex))

  it('handles the padding boundaries (55, 56, 63, 64, 65 bytes) like Node crypto', async () => {
    const { createHash } = await import('node:crypto')
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100_000]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255)
      expect(toHex(md5(data)), `length ${n}`).toBe(createHash('md5').update(data).digest('hex'))
    }
  })
})

describe('RC4', () => {
  it('Wikipedia vectors', () => {
    expect(toHex(rc4(utf8('Key'), utf8('Plaintext')))).toBe('bbf316e8d940af0ad3')
    expect(toHex(rc4(utf8('Wiki'), utf8('pedia')))).toBe('1021bf0420')
    expect(toHex(rc4(utf8('Secret'), utf8('Attack at dawn')))).toBe('45a01f645fc35b383552544b9bf5')
  })
  it('RFC 6229: key 0102030405, first keystream bytes', () => {
    const ks = rc4(fromHex('0102030405'), new Uint8Array(16))
    expect(toHex(ks)).toBe('b2396305f03dc027ccc3524a0a1118a8')
  })
  it('is its own inverse', () => {
    const data = utf8('round trip me, please')
    expect(rc4(utf8('k'), rc4(utf8('k'), data))).toEqual(data)
  })
})

describe('AES (FIPS-197 / NIST SP 800-38A)', () => {
  it('FIPS-197 C.1: AES-128 block', () => {
    const key = fromHex('000102030405060708090a0b0c0d0e0f')
    const pt = fromHex('00112233445566778899aabbccddeeff')
    const ct = ecbEncryptBlock(key, pt)
    expect(toHex(ct)).toBe('69c4e0d86a7b0430d8cdb78070b4c55a')
    expect(toHex(ecbDecryptBlock(key, ct))).toBe(toHex(pt))
  })
  it('FIPS-197 C.3: AES-256 block', () => {
    const key = fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
    const pt = fromHex('00112233445566778899aabbccddeeff')
    const ct = ecbEncryptBlock(key, pt)
    expect(toHex(ct)).toBe('8ea2b7ca516745bfeafc49904b496089')
    expect(toHex(ecbDecryptBlock(key, ct))).toBe(toHex(pt))
  })
  it('FIPS-197 C.2: AES-192 block', () => {
    const key = fromHex('000102030405060708090a0b0c0d0e0f1011121314151617')
    expect(toHex(ecbEncryptBlock(key, fromHex('00112233445566778899aabbccddeeff')))).toBe('dda97ca4864cdfe06eaf70a0ec0d7191')
  })
  const iv = fromHex('000102030405060708090a0b0c0d0e0f')
  const pt = fromHex('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51')
  it('SP 800-38A F.2.1: CBC-AES128', () => {
    const key = fromHex('2b7e151628aed2a6abf7158809cf4f3c')
    const ct = cbcEncryptRaw(key, iv, pt)
    expect(toHex(ct)).toBe('7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b2')
    expect(toHex(cbcDecryptRaw(key, iv, ct))).toBe(toHex(pt))
  })
  it('SP 800-38A F.2.5: CBC-AES256', () => {
    const key = fromHex('603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4')
    const ct = cbcEncryptRaw(key, iv, pt)
    expect(toHex(ct)).toBe('f58c4c04d6e5f1ba779eabfb5f7bfbd69cfc4e967edb808d679f777bc6702c7d')
    expect(toHex(cbcDecryptRaw(new Aes(key), iv, ct))).toBe(toHex(pt))
  })
  it('agrees with Node crypto on random data of many lengths and both key sizes', async () => {
    const { createCipheriv, createDecipheriv, randomBytes } = await import('node:crypto')
    for (const keyLen of [16, 32]) {
      for (const n of [0, 1, 15, 16, 17, 31, 32, 1000, 65_537]) {
        const key = new Uint8Array(randomBytes(keyLen))
        const ivv = new Uint8Array(randomBytes(16))
        const data = new Uint8Array(randomBytes(n))
        const enc = aesPdfEncrypt(key, data, ivv)
        const c = createCipheriv(keyLen === 16 ? 'aes-128-cbc' : 'aes-256-cbc', key, ivv)
        const expected = Buffer.concat([ivv, c.update(data), c.final()])
        expect(toHex(enc), `enc ${keyLen}/${n}`).toBe(expected.toString('hex'))
        expect(aesPdfDecrypt(key, enc)).toEqual(data)
        const d = createDecipheriv(keyLen === 16 ? 'aes-128-cbc' : 'aes-256-cbc', key, ivv)
        expect(Buffer.concat([d.update(enc.subarray(16)), d.final()]).equals(Buffer.from(data))).toBe(true)
      }
    }
  })
  it('PDF padding: always 1-16 bytes; damaged padding is kept rather than throwing', () => {
    expect(pkcs7Pad(new Uint8Array(16)).length).toBe(32)
    expect(pkcs7Pad(new Uint8Array(15))[15]).toBe(1)
    expect(pkcs7UnpadLenient(concat(utf8('abc'), new Uint8Array(13).fill(0x77)))).toHaveLength(16) // bad pad byte: untouched
    expect(pkcs7UnpadLenient(concat(utf8('abc'), new Uint8Array(13).fill(13)))).toEqual(utf8('abc'))
    expect(aesPdfDecrypt(new Uint8Array(16), new Uint8Array(10))).toHaveLength(0)
  })
  it('rejects bad key sizes', () => {
    expect(() => new Aes(new Uint8Array(15))).toThrow()
  })
  it('latin1 helper round trips', () => {
    expect(toHex(fromLatin1('äÿ'))).toBe('e4ff')
  })
})
