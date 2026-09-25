import { convertCsv } from './csv'
import { readDocx } from './docx'
import { OfficeError, PAGE_A4, type ConvertEnv } from './env'
import { FontCatalog } from './fonts'
import { convertOdp } from './odp'
import { convertOds } from './ods'
import { readOdt } from './odt'
import { renderPagesToPdf, Warnings, type Page } from './ops'
import { paginateFlow } from './paginate'
import { convertPptx } from './pptx'
import { readRtf } from './rtf'
import { readPlainText } from './text'
import { convertXlsx } from './xlsx'
import { extensionOf } from '../../../../shared/features/create'

/**
 * Epdf's built-in Office -> PDF converter (no external program needed). Supported: txt, csv, docx, xlsx,
 * pptx, odt, ods, odp, rtf. Legacy binary formats (doc, xls, ppt) are refused with a clear message.
 * Layout is approximate: text is set in bundled, metric-compatible fonts and paginated by Epdf itself.
 */

export interface OfficeOptions {
  fontsDir: string
  signal?: AbortSignal
  onProgress?: (fraction: number, message?: string) => void
  /** Page size for formats without one. Defaults to A4. */
  page?: { width: number; height: number }
}

export interface OfficeResult {
  bytes: Uint8Array
  pages: number
  /** User-presentable notes about anything that was approximated or left out. */
  warnings: string[]
}

export const BUILTIN_EXTENSIONS = ['txt', 'csv', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf'] as const
const LEGACY: Record<string, string> = { doc: '.docx', xls: '.xlsx', ppt: '.pptx' }

export function builtinSupports(name: string): boolean {
  return (BUILTIN_EXTENSIONS as readonly string[]).includes(extensionOf(name))
}

export function legacyMessage(name: string): string | null {
  const ext = extensionOf(name)
  const modern = LEGACY[ext]
  if (!modern) return null
  return `“${name}” is an old binary .${ext} file, which Epdf cannot convert by itself. Open it in its own program and save it as ${modern} first (or use the optional LibreOffice engine).`
}

export async function convertOffice(input: { name: string; bytes: Uint8Array }, opts: OfficeOptions): Promise<OfficeResult> {
  const ext = extensionOf(input.name)
  const legacy = legacyMessage(input.name)
  if (legacy) throw new OfficeError(legacy)
  if (!builtinSupports(input.name)) throw new OfficeError(`“${input.name}” is not a file type Epdf can convert.`)
  const warnings = new Warnings()
  const catalog = new FontCatalog(opts.fontsDir)
  const progress = opts.onProgress ?? (() => undefined)
  const env: ConvertEnv = { catalog, warnings, signal: opts.signal, progress, page: opts.page ?? PAGE_A4 }
  const scale = (from: number, to: number) => (f: number, m?: string) => progress(from + (to - from) * f, m)
  let pages: Page[]
  const label = (msg: string): string => `${input.name}: ${msg}`
  try {
    progress(0.02, 'Reading document')
    switch (ext) {
      case 'txt':
        pages = paginateFlow(readPlainText(input.bytes, env), catalog, warnings, { signal: opts.signal, onProgress: scale(0.05, 0.7) })
        break
      case 'docx':
        pages = paginateFlow(await readDocx(input.bytes, env), catalog, warnings, { signal: opts.signal, onProgress: scale(0.1, 0.7) })
        break
      case 'odt':
        pages = paginateFlow({ ...(await readOdt(input.bytes, env)), suppressSpaceBeforeAtPageTop: true }, catalog, warnings, { signal: opts.signal, onProgress: scale(0.1, 0.7) })
        break
      case 'rtf':
        pages = paginateFlow({ ...readRtf(input.bytes, env), suppressSpaceBeforeAtPageTop: true }, catalog, warnings, { signal: opts.signal, onProgress: scale(0.1, 0.7) })
        break
      case 'xlsx':
        pages = await convertXlsx(input.bytes, { ...env, progress: scale(0.05, 0.7) })
        break
      case 'ods':
        pages = await convertOds(input.bytes, { ...env, progress: scale(0.05, 0.7) })
        break
      case 'csv':
        pages = convertCsv(input.bytes, { ...env, progress: scale(0.05, 0.7) })
        break
      case 'pptx':
        pages = await convertPptx(input.bytes, { ...env, progress: scale(0.05, 0.7) })
        break
      case 'odp':
        pages = await convertOdp(input.bytes, { ...env, progress: scale(0.05, 0.7) })
        break
      default:
        throw new OfficeError(`“${input.name}” is not a file type Epdf can convert.`)
    }
  } catch (err) {
    if (err instanceof OfficeError || (err instanceof Error && err.message === 'Cancelled')) throw err
    throw new OfficeError(label(`this file could not be converted (${err instanceof Error ? err.message : String(err)}).`))
  }
  if (pages.length === 0) pages = [{ width: env.page.width, height: env.page.height, ops: [] }]
  progress(0.72, 'Writing PDF')
  const title = input.name.replace(/\.[^.]+$/, '')
  const bytes = await renderPagesToPdf(pages, catalog, { title, warnings, signal: opts.signal, onPage: (d, t) => progress(0.72 + 0.27 * (d / t), `Writing page ${d} of ${t}`) })
  if (catalog.missing.size) {
    const sample = [...catalog.missing].slice(0, 8).join(' ')
    warnings.add(`Some characters are not available in Epdf’s built-in fonts and were replaced with “?” (for example ${sample}). Use the LibreOffice engine for full Unicode coverage.`)
  }
  progress(1)
  return { bytes, pages: pages.length, warnings: warnings.list() }
}
