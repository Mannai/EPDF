import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { findPack as findLanguage, OCR_LANGUAGES, packData, type LanguageStatus, type OcrLanguage } from '../../../shared/features/ocr'

/**
 * Where trained-data files live and how they are trusted. `eng` ships inside the app (`bundledDir`);
 * everything else is downloaded into `userDir` (userData/ocr-languages). Every file is checked against the
 * SHA-256 pinned in the catalogue before Tesseract is allowed to read it.
 */

export interface LanguageStoreOptions {
  bundledDir: string
  userDir: string
  /** Test hook: replaces catalogue hashes (code -> sha256). Ignored in packaged builds by the caller. */
  hashOverrides?: Record<string, string>
}

export const fileNameOf = (code: string): string => `${code}.traineddata`

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

export class LanguageStore {
  constructor(private opts: LanguageStoreOptions) {}

  get userDir(): string {
    return this.opts.userDir
  }

  /** The hash a file for this language must have. */
  expectedHash(lang: OcrLanguage): string {
    return this.opts.hashOverrides?.[lang.code] ?? lang.sha256
  }

  /** Where the file for `code` is (or would be). */
  pathOf(code: string): string {
    const lang = findLanguage(code)
    if (!lang) throw new Error(`Unsupported language: ${code}`)
    return join(lang.bundled ? this.opts.bundledDir : this.opts.userDir, fileNameOf(code))
  }

  async isInstalled(code: string): Promise<boolean> {
    try {
      return (await stat(this.pathOf(code))).isFile()
    } catch {
      return false
    }
  }

  async list(): Promise<LanguageStatus[]> {
    return Promise.all(OCR_LANGUAGES.map(async (l) => ({ ...l, installed: await this.isInstalled(l.code) })))
  }

  /** One pack (a language or the orientation data) with its install state. */
  async status(code: string): Promise<LanguageStatus> {
    const lang = findLanguage(code)
    if (!lang) throw new Error(`Unsupported language: ${code}`)
    return { ...lang, installed: await this.isInstalled(code) }
  }

  /** Throws a user-presentable error unless the file exists and matches its pinned hash. */
  async verify(code: string): Promise<string> {
    const lang = findLanguage(code)
    if (!lang) throw new Error(`Unsupported language: ${code}`)
    const path = this.pathOf(code)
    if (!(await this.isInstalled(code))) throw new Error(`The ${packData(lang)} is not installed. Download it first.`)
    const actual = await sha256File(path)
    if (actual !== this.expectedHash(lang)) {
      throw new Error(`The ${packData(lang)} on disk is damaged or has been modified, so it was not used. Remove it and download it again.`)
    }
    return path
  }

  /** Removes a downloaded pack. The bundled English data cannot be removed. */
  async remove(code: string): Promise<void> {
    const lang = findLanguage(code)
    if (!lang) throw new Error(`Unsupported language: ${code}`)
    if (lang.bundled) throw new Error(`${lang.name} is part of Epdf and cannot be removed.`)
    await rm(this.pathOf(code), { force: true })
  }

  /** Copies verified packs into `dir` (a per-job temp folder) under the names Tesseract expects. */
  async stageInto(dir: string, codes: string[]): Promise<void> {
    await mkdir(dir, { recursive: true })
    for (const code of codes) {
      const src = await this.verify(code)
      await copyFile(src, join(dir, fileNameOf(code)))
    }
  }

  /** Deletes leftovers of interrupted downloads (`*.part`). */
  async sweepPartials(): Promise<void> {
    try {
      for (const f of await readdir(this.opts.userDir)) if (f.endsWith('.part')) await rm(join(this.opts.userDir, f), { force: true })
    } catch {
      /* folder does not exist yet */
    }
  }
}
