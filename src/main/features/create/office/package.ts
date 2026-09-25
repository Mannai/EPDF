import { unzipSync } from 'fflate'
import { parseXml, type XNode } from './xml'
import { OfficeError } from './env'

/** Zip-based document container (OOXML and ODF). Parts are read lazily as text/XML/bytes. */
export interface Pkg {
  names(): string[]
  has(name: string): boolean
  bytes(name: string): Uint8Array | undefined
  text(name: string): string | undefined
  xml(name: string): XNode | undefined
}

const MAX_PART = 400 * 1024 * 1024
const MAX_TOTAL = 1024 * 1024 * 1024

export function openPackage(data: Uint8Array, what = 'document'): Pkg {
  let files: Record<string, Uint8Array>
  let total = 0
  try {
    files = unzipSync(data, {
      filter: (f) => {
        if (f.originalSize > MAX_PART) throw new OfficeError(`The ${what} contains a part that is unreasonably large.`)
        total += f.originalSize
        if (total > MAX_TOTAL) throw new OfficeError(`The ${what} expands to an unreasonable size.`)
        return true
      }
    })
  } catch (err) {
    if (err instanceof OfficeError) throw err
    throw new OfficeError(`The ${what} is damaged or is not a valid Office file (it could not be opened as a zip package).`)
  }
  // Part names are case-insensitive in practice; index them by a normalised key too.
  const byLower = new Map<string, string>()
  for (const k of Object.keys(files)) byLower.set(normalize(k), k)
  const dec = new TextDecoder('utf-8')
  const cache = new Map<string, XNode>()
  const real = (name: string): string | undefined => (name in files ? name : byLower.get(normalize(name)))
  return {
    names: () => Object.keys(files),
    has: (n) => real(n) !== undefined,
    bytes: (n) => {
      const r = real(n)
      return r === undefined ? undefined : files[r]
    },
    text: (n) => {
      const r = real(n)
      return r === undefined ? undefined : dec.decode(files[r])
    },
    xml: (n) => {
      const r = real(n)
      if (r === undefined) return undefined
      let x = cache.get(r)
      if (!x) {
        x = parseXml(dec.decode(files[r]))
        cache.set(r, x)
      }
      return x
    }
  }
}

const normalize = (n: string): string => n.replace(/^\/+/, '').toLowerCase()

/** Resolves a relationship target against the directory of its source part (`word/document.xml` + `media/a.png`). */
export function resolveTarget(sourcePart: string, target: string): string {
  if (/^[a-z]+:/i.test(target)) return target // external
  if (target.startsWith('/')) return target.slice(1)
  const dir = sourcePart.includes('/') ? sourcePart.slice(0, sourcePart.lastIndexOf('/')) : ''
  const parts = (dir ? dir.split('/') : []).concat(target.split('/'))
  const out: string[] = []
  for (const p of parts) {
    if (p === '.' || p === '') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return out.join('/')
}

export interface Relationship {
  id: string
  type: string
  target: string
  external: boolean
}

/** Reads `<dir>/_rels/<file>.rels` for a part; targets are resolved to package paths (external ones kept as URLs). */
export function relationshipsOf(pkg: Pkg, part: string): Map<string, Relationship> {
  const slash = part.lastIndexOf('/')
  const relPath = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
  const out = new Map<string, Relationship>()
  const root = pkg.xml(relPath)
  if (!root) return out
  const rels = root.children.find((c) => c.name === 'Relationships')
  for (const r of rels?.children ?? []) {
    if (r.name !== 'Relationship') continue
    const id = r.attrs['Id'] ?? ''
    const target = r.attrs['Target'] ?? ''
    const external = (r.attrs['TargetMode'] ?? '') === 'External'
    out.set(id, { id, type: (r.attrs['Type'] ?? '').replace(/^.*\//, ''), target: external ? target : resolveTarget(part, target), external })
  }
  return out
}

export function imageFormat(bytes: Uint8Array): 'png' | 'jpeg' | 'gif' | 'bmp' | 'emf' | 'wmf' | 'svg' | 'tiff' | 'unknown' {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif'
  if (bytes.length > 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp'
  if (bytes.length > 44 && bytes[40] === 0x20 && bytes[41] === 0x45 && bytes[42] === 0x4d && bytes[43] === 0x46) return 'emf'
  if (bytes.length > 4 && bytes[0] === 0xd7 && bytes[1] === 0xcd && bytes[2] === 0xc6 && bytes[3] === 0x9a) return 'wmf'
  if (bytes.length > 4 && (bytes[0] === 0x49 || bytes[0] === 0x4d) && (bytes[1] === 0x49 || bytes[1] === 0x4d) && (bytes[2] === 0x2a || bytes[3] === 0x2a)) return 'tiff'
  const head = new TextDecoder().decode(bytes.subarray(0, 200)).toLowerCase()
  if (head.includes('<svg') || head.includes('<?xml')) return 'svg'
  return 'unknown'
}
