/** Small byte helpers shared by the crypto code. No DOM, no Node-only APIs: runs in the renderer and in Node. */

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export const toHex = (b: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16)
  return s
}

export const fromHex = (h: string): Uint8Array => {
  const clean = h.replace(/\s+/g, '')
  const out = new Uint8Array(clean.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16)
  return out
}

/** Bytes to a string with one char per byte. */
export const latin1 = (b: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192))
  return s
}

export const fromLatin1 = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export const randomBytes = (n: number): Uint8Array => {
  const out = new Uint8Array(n)
  // getRandomValues is limited to 65536 bytes per call.
  for (let i = 0; i < n; i += 65536) globalThis.crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)))
  return out
}

/** Resolves on the next macrotask so a long loop does not freeze the UI. */
export const yieldToEventLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
