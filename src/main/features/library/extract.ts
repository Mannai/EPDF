import { createHash } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs'
import { prepareIndexText } from '../../../shared/features/library/text'

/**
 * Text extraction for the index: reads one PDF from disk and returns the text of every page. Runs inside the
 * index worker thread (pdf.js legacy build, no DOM, no canvas). Never throws for a bad PDF: encrypted, damaged and
 * image-only files come back as a result that says so, so one bad file can never stop the indexer.
 */

// pdf.js normally starts its own worker; here it runs in this thread using the handler we hand it.
;(globalThis as unknown as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker

export interface ExtractAssets {
  /** Folder with the CMaps (trailing separator), for CJK fonts that are not embedded. */
  cMapUrl: string
  standardFontDataUrl: string
}

export interface ExtractRequest {
  path: string
  /** Hash stored for this file; when it still matches, the content did not change and nothing is extracted. */
  knownHash: string | null
  maxPages: number
  assets: ExtractAssets
  /** Give up on a single page after this long (a hostile page must not hang the indexer). */
  pageTimeoutMs?: number
}

export type ExtractResult =
  | { kind: 'missing' }
  | { kind: 'unchanged'; hash: string; size: number }
  | { kind: 'unindexable'; hash: string | null; size: number; reason: string }
  | {
      kind: 'indexed' | 'no_text'
      hash: string
      size: number
      pages: number
      /** Cleaned text of every page that has any (1-based page numbers). */
      texts: { page: number; text: string }[]
      words: number
      note: string
    }

const QUICK_BYTES = 64 * 1024

/** SHA-1 over the size and the first and last 64 KB: cheap, and any real edit changes it. */
export function quickHash(bytes: Uint8Array): string {
  const h = createHash('sha1')
  h.update(String(bytes.length))
  h.update(bytes.subarray(0, QUICK_BYTES))
  if (bytes.length > QUICK_BYTES) h.update(bytes.subarray(Math.max(QUICK_BYTES, bytes.length - QUICK_BYTES)))
  return h.digest('hex')
}

/** Reads the hash of a file without extracting anything (used to recognise moved files). */
export async function hashFile(path: string): Promise<{ hash: string; size: number } | null> {
  const fh = await open(path, 'r').catch(() => null)
  if (!fh) return null
  try {
    const { size } = await fh.stat()
    const head = Buffer.alloc(Math.min(size, QUICK_BYTES))
    await fh.read(head, 0, head.length, 0)
    const h = createHash('sha1')
    h.update(String(size))
    h.update(head)
    if (size > QUICK_BYTES) {
      const tailStart = Math.max(QUICK_BYTES, size - QUICK_BYTES)
      const tail = Buffer.alloc(size - tailStart)
      await fh.read(tail, 0, tail.length, tailStart)
      h.update(tail)
    }
    return { hash: h.digest('hex'), size }
  } finally {
    await fh.close()
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} took too long`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })

function describeError(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: number }
  if (e?.name === 'PasswordException') return 'Password-protected (encrypted): the text cannot be indexed.'
  if (e?.name === 'InvalidPDFException') return 'Damaged or invalid PDF: the text cannot be read.'
  if (e?.name === 'MissingPDFException') return 'The file is not available.'
  const msg = (e?.message ?? 'unknown error').toString().replace(/\s+/g, ' ').slice(0, 160)
  return `The text could not be read (${msg}).`
}

const countWords = (s: string): number => (s.match(/[\p{L}\p{N}]+/gu) ?? []).length

/** Extracts the text of every page. `path` must be a local file (the caller never passes a cloud placeholder). */
export async function extractText(req: ExtractRequest): Promise<ExtractResult> {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(req.path))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' }
    return { kind: 'unindexable', hash: null, size: 0, reason: `The file cannot be read (${code ?? 'error'}).` }
  }
  const size = bytes.length
  const hash = quickHash(bytes)
  if (req.knownHash && req.knownHash === hash) return { kind: 'unchanged', hash, size }
  if (size === 0) return { kind: 'unindexable', hash, size, reason: 'The file is empty.' }
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1')
  if (!head.includes('%PDF-')) return { kind: 'unindexable', hash, size, reason: 'Not a PDF file (no PDF header).' }

  const task = pdfjs.getDocument({
    data: bytes,
    useSystemFonts: false,
    disableFontFace: true,
    enableXfa: false,
    verbosity: 0,
    cMapUrl: req.assets.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: req.assets.standardFontDataUrl
  })
  try {
    const doc = await task.promise
    const total = doc.numPages
    const limit = Math.min(total, req.maxPages)
    const texts: { page: number; text: string }[] = []
    let words = 0
    let failedPages = 0
    let chars = 0
    for (let p = 1; p <= limit; p++) {
      try {
        const page = await doc.getPage(p)
        const content = await withTimeout(page.getTextContent(), req.pageTimeoutMs ?? 20_000, `Page ${p}`)
        page.cleanup()
        let raw = ''
        for (const item of content.items) {
          if (!('str' in item)) continue
          raw += item.str
          if (item.hasEOL) raw += '\n'
        }
        const text = prepareIndexText(raw.slice(0, 400_000))
        if (text) {
          texts.push({ page: p, text })
          words += countWords(text)
          chars += text.length
        }
      } catch {
        failedPages++
      }
      if (chars > 60_000_000) break
    }
    const notes: string[] = []
    if (limit < total) notes.push(`Only the first ${limit.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} pages were indexed.`)
    if (failedPages > 0) notes.push(`${failedPages} page${failedPages === 1 ? '' : 's'} could not be read.`)
    if (words === 0) {
      if (failedPages === limit && limit > 0) return { kind: 'unindexable', hash, size, reason: 'The text could not be read (every page failed).' }
      notes.unshift('No text found. It may be scanned: run OCR to make it searchable.')
      return { kind: 'no_text', hash, size, pages: total, texts: [], words: 0, note: notes.join(' ') }
    }
    return { kind: 'indexed', hash, size, pages: total, texts, words, note: notes.join(' ') }
  } catch (err) {
    return { kind: 'unindexable', hash, size, reason: describeError(err) }
  } finally {
    await task.destroy().catch(() => undefined)
  }
}
