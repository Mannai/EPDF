import { describe, expect, it } from 'vitest'
import { MAX_STAMP_IMAGE_BYTES, sniffImage, systemUserName } from '../../src/main/features/markup/image'

describe('custom stamp image validation (main process)', () => {
  it('recognises PNG and JPEG by signature, not by name', () => {
    expect(sniffImage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('png')
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('jpg')
  })

  it('rejects everything else: text, PDF, GIF, truncated data, empty', () => {
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
    expect(sniffImage(enc('%PDF-1.7'))).toBeNull()
    expect(sniffImage(enc('GIF89a'))).toBeNull()
    expect(sniffImage(enc('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffImage(Uint8Array.from([0x89, 0x50, 0x4e]))).toBeNull()
    expect(sniffImage(new Uint8Array())).toBeNull()
  })

  it('limits the image size to 25 MB', () => {
    expect(MAX_STAMP_IMAGE_BYTES).toBe(25 * 1024 * 1024)
  })
})

describe('default author from the OS', () => {
  it('returns the trimmed user name and never throws', () => {
    expect(systemUserName(() => ({ username: '  ada  ' }))).toBe('ada')
    expect(
      systemUserName(() => {
        throw new Error('no passwd entry')
      })
    ).toBe('')
    expect(systemUserName(() => ({ username: undefined as unknown as string }))).toBe('')
  })
})
