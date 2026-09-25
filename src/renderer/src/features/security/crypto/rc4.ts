/** RC4. Only used because the legacy PDF security handlers (revisions 2-4 with /V 1, 2, 4 + V2) require it. */
export class Rc4 {
  private readonly s = new Uint8Array(256)
  private a = 0
  private b = 0

  constructor(key: Uint8Array) {
    const s = this.s
    for (let i = 0; i < 256; i++) s[i] = i
    let j = 0
    for (let i = 0; i < 256; i++) {
      j = (j + s[i] + key[i % key.length]) & 255
      const t = s[i]
      s[i] = s[j]
      s[j] = t
    }
  }

  /** XORs the key stream into `data[start..end)` in place (RC4 is symmetric); the state carries over between calls. */
  applyInPlace(data: Uint8Array, start = 0, end = data.length): void {
    const s = this.s
    let a = this.a
    let b = this.b
    for (let n = start; n < end; n++) {
      a = (a + 1) & 255
      b = (b + s[a]) & 255
      const t = s[a]
      s[a] = s[b]
      s[b] = t
      data[n] ^= s[(s[a] + s[b]) & 255]
    }
    this.a = a
    this.b = b
  }
}

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const out = data.slice()
  new Rc4(key).applyInPlace(out)
  return out
}
