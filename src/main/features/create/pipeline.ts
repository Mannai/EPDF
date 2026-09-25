import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { JobContext } from '../../jobs/JobManager'
import { classifyName, safeFileBase, type Engine, type ImageOptions, type PickedFile, type SourceKind } from '../../../shared/features/create'
import { notInstalledMessage, type LibreOfficeJob } from './libreoffice'
import { builtinSupports, legacyMessage } from './office'
import type { PdfResult, ProbeResult, WorkerRequest } from './workerOps'

/**
 * The orchestration of "make a PDF from this file": picks the right converter per file type, reports progress,
 * and returns PDF bytes. It knows nothing about dialogs or windows, so it is unit-testable; the Electron pieces
 * (worker threads, LibreOffice, the OS HEIC decoder) are injected.
 */

export interface Source {
  id: string
  path: string
  name: string
  size: number
  kind: SourceKind
  pages: number | null
  problem?: string
}

/** Files the user picked in a native dialog. The renderer only ever holds the ids, never a path. */
export class SourceRegistry {
  private map = new Map<string, Source>()
  register(s: Omit<Source, 'id'>): Source {
    const src: Source = { ...s, id: randomUUID() }
    this.map.set(src.id, src)
    if (this.map.size > 2000) this.map.delete(this.map.keys().next().value as string)
    return src
  }
  get(id: string): Source | undefined {
    return this.map.get(id)
  }
  require(id: string): Source {
    const s = this.map.get(id)
    if (!s) throw new Error('That file is no longer available. Choose it again.')
    return s
  }
}

export const toPicked = (s: Source): PickedFile => ({ id: s.id, name: s.name, size: s.size, kind: s.kind, pages: s.pages, problem: s.problem })

export interface PipelineDeps {
  fontsDir: string
  /** Runs a heavy operation in a worker thread (or inline in tests). */
  run(req: WorkerRequest, ctx: JobContext): Promise<PdfResult | ProbeResult>
  /** Decodes a HEIC/HEIF picture with the operating system. */
  heicToJpeg(input: { path: string; name: string }, ctx: JobContext): Promise<Uint8Array>
  /** Path of an installed LibreOffice, or null. */
  findSoffice(): string | null
  convertWithLibreOffice(job: Omit<LibreOfficeJob, 'ctx'>, ctx: JobContext): Promise<Uint8Array>
  page: { width: number; height: number }
}

export interface ConvertOptions {
  images: ImageOptions
  engine: Engine
}

export type PdfSource = { path: string } | { bytes: Uint8Array }

export interface Converted {
  source: Source
  pdf: PdfSource
  pages: number | null
  warnings: string[]
}

/** Registers a file: kind from its name, size from disk. Returns null (with a reason) when unsupported. */
export async function describeFile(path: string): Promise<Omit<Source, 'id'> | { skip: string }> {
  const name = basename(path)
  const kind = classifyName(name)
  if (!kind) return { skip: 'This type of file cannot be turned into a PDF.' }
  try {
    const st = await stat(path)
    if (!st.isFile()) return { skip: 'This is not a file.' }
    return { path, name, size: st.size, kind, pages: kind === 'image' || kind === 'heic' ? 1 : null }
  } catch {
    return { skip: 'The file could not be read.' }
  }
}

const asPdf = (r: PdfResult | ProbeResult): PdfResult => r as PdfResult

/** Converts one source to a PDF. PDFs are passed through by path (not read). Throws with a user-presentable message. */
export async function convertSource(src: Source, deps: PipelineDeps, opts: ConvertOptions, ctx: JobContext): Promise<Converted> {
  switch (src.kind) {
    case 'pdf':
      return { source: src, pdf: { path: src.path }, pages: src.pages, warnings: [] }
    case 'image':
    case 'tiff': {
      const r = asPdf(await deps.run({ op: 'images', files: [{ path: src.path, name: src.name }], options: opts.images }, ctx))
      return { source: src, pdf: { bytes: r.bytes }, pages: r.pages, warnings: r.warnings }
    }
    case 'heic': {
      const jpeg = await deps.heicToJpeg({ path: src.path, name: src.name }, ctx)
      const r = asPdf(await deps.run({ op: 'imageBytes', name: src.name, bytes: jpeg, options: opts.images }, ctx))
      return { source: src, pdf: { bytes: r.bytes }, pages: r.pages, warnings: r.warnings }
    }
    case 'office': {
      if (opts.engine === 'libreoffice') {
        const soffice = deps.findSoffice()
        if (!soffice) throw new Error(notInstalledMessage('Converting Office documents with LibreOffice'))
        const bytes = await deps.convertWithLibreOffice({ soffice, inputPath: src.path, inputName: src.name }, ctx)
        return { source: src, pdf: { bytes }, pages: null, warnings: [] }
      }
      const legacy = legacyMessage(src.name)
      if (legacy) throw new Error(legacy)
      if (!builtinSupports(src.name)) throw new Error(`“${src.name}” is not a file type Epdf can convert.`)
      const r = asPdf(await deps.run({ op: 'office', path: src.path, name: src.name, fontsDir: deps.fontsDir, page: deps.page }, ctx))
      return { source: src, pdf: { bytes: r.bytes }, pages: r.pages, warnings: r.warnings }
    }
  }
}

export interface BatchResult {
  ok: { converted: Converted; bytes: Uint8Array }[]
  failed: { name: string; error: string }[]
}

export async function readPdfSource(pdf: PdfSource): Promise<Uint8Array> {
  if ('bytes' in pdf) return pdf.bytes
  const { readFile } = await import('node:fs/promises')
  return new Uint8Array(await readFile(pdf.path))
}

/** Converts several files one by one. A failing file is reported and skipped; cancelling stops everything. */
export async function convertAll(sources: Source[], deps: PipelineDeps, opts: ConvertOptions, ctx: JobContext): Promise<BatchResult> {
  const out: BatchResult = { ok: [], failed: [] }
  for (let i = 0; i < sources.length; i++) {
    if (ctx.signal.aborted) throw new Error('Cancelled')
    const src = sources[i]
    const sub: JobContext = {
      signal: ctx.signal,
      progress: (f, m) => ctx.progress((i + Math.min(1, Math.max(0, f))) / sources.length * 0.98, m ?? `Converting ${src.name}`)
    }
    ctx.progress(i / sources.length, `Converting ${src.name}`)
    try {
      const converted = await convertSource(src, deps, opts, sub)
      out.ok.push({ converted, bytes: await readPdfSource(converted.pdf) })
    } catch (err) {
      if (ctx.signal.aborted || (err instanceof Error && err.message === 'Cancelled')) throw new Error('Cancelled')
      out.failed.push({ name: src.name, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// Output names
// ---------------------------------------------------------------------------------------------------

/** `<dir>/<base>.pdf`, or `<base> (2).pdf`, ... when that already exists. `taken` also excludes names chosen earlier in the same batch. */
export function uniquePdfPath(dir: string, base: string, exists: (p: string) => boolean, taken: Set<string> = new Set()): string {
  const safe = safeFileBase(base, 'Document')
  let n = 1
  for (;;) {
    const p = join(dir, n === 1 ? `${safe}.pdf` : `${safe} (${n}).pdf`)
    if (!exists(p) && !taken.has(p.toLowerCase())) {
      taken.add(p.toLowerCase())
      return p
    }
    n++
  }
}

export const baseNameOf = (name: string): string => basename(name, extname(name))
export const dirOf = (path: string): string => dirname(path)
