/** A small, strict multipart/form-data parser (RFC 7578) for the phone upload endpoint. Works on a fully buffered body. */

export class MultipartError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message)
    this.name = 'MultipartError'
  }
}

export interface Part {
  name: string | null
  filename: string | null
  contentType: string | null
  data: Buffer
}

/** The boundary from a Content-Type header, or null when it is not multipart/form-data or the boundary is not sane. */
export function boundaryFrom(contentType: string | undefined): string | null {
  if (!contentType) return null
  const m = /^\s*multipart\/form-data\s*;\s*boundary=(?:"([^"]{1,70})"|([^\s;",]{1,70}))\s*$/i.exec(contentType)
  const b = m?.[1] ?? m?.[2]
  return b && /^[0-9A-Za-z'()+_,\-./:=? ]{1,70}$/.test(b) && !/ $/.test(b) ? b : null
}

const CRLF2 = Buffer.from('\r\n\r\n')

function parseDisposition(v: string): { name: string | null; filename: string | null } | null {
  if (!/^\s*form-data\s*(;|$)/i.test(v)) return null
  const get = (key: string): string | null => {
    const m = new RegExp(`;\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]*))`, 'i').exec(v)
    if (!m) return null
    return (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1')
  }
  return { name: get('name'), filename: get('filename') }
}

export function parseMultipart(body: Buffer, boundary: string, limits: { maxParts: number; maxHeaderBytes?: number }): Part[] {
  const maxHeader = limits.maxHeaderBytes ?? 8192
  const delim = Buffer.from(`--${boundary}`)
  const next = Buffer.from(`\r\n--${boundary}`)
  let pos = body.indexOf(delim)
  if (pos < 0 || pos > 1024) throw new MultipartError('The upload is not valid multipart data.')
  const parts: Part[] = []
  for (;;) {
    pos += delim.length
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) return parts // closing delimiter
    if (body[pos] !== 0x0d || body[pos + 1] !== 0x0a) throw new MultipartError('The upload is not valid multipart data.')
    pos += 2
    const headEnd = body.indexOf(CRLF2, pos)
    if (headEnd < 0 || headEnd - pos > maxHeader) throw new MultipartError('The upload has invalid part headers.')
    const headers = body.subarray(pos, headEnd).toString('latin1').split('\r\n')
    const dataStart = headEnd + 4
    const end = body.indexOf(next, dataStart)
    if (end < 0) throw new MultipartError('The upload ended unexpectedly.')
    if (parts.length >= limits.maxParts) throw new MultipartError('Too many parts in one upload.', 413)
    let disposition: { name: string | null; filename: string | null } | null = null
    let contentType: string | null = null
    for (const h of headers) {
      const c = h.indexOf(':')
      if (c < 1) throw new MultipartError('The upload has invalid part headers.')
      const key = h.slice(0, c).trim().toLowerCase()
      const val = h.slice(c + 1).trim()
      if (key === 'content-disposition') disposition = parseDisposition(val)
      else if (key === 'content-type') contentType = val.slice(0, 200)
    }
    if (!disposition) throw new MultipartError('The upload has an invalid part.')
    parts.push({ name: disposition.name, filename: disposition.filename, contentType, data: body.subarray(dataStart, end) })
    pos = end + 2 // now at the delimiter
  }
}

export type SniffedImage = 'image/jpeg' | 'image/png' | 'image/webp'

/** What the bytes really are; the client's claimed type and file name are never trusted. */
export function sniffImage(b: Uint8Array): SniffedImage | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}
