import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ORIENTATION_CONFIDENCE, OSD_PACK, type OrientationResult } from '../../../shared/features/ocr'
import { tesseractWorkerPath } from './engine'
import type { LanguageStore } from './languages'

/**
 * Page orientation (is the scan turned by 90, 180 or 270 degrees?) with Tesseract's orientation and script detection
 * (`osd.traineddata`, an optional download). It runs on Tesseract's legacy engine, in its own tesseract.js worker
 * thread, only for runs that asked for it, and takes about a quarter of a second per page (measured on 300 dpi A5
 * pages). One detector per recognition run; `terminate` removes its temp copy of the data.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tess = any

export class OrientationDetector {
  private constructor(
    private worker: Tess,
    private dir: string
  ) {}

  static async create(store: LanguageStore, tempRoot: string): Promise<OrientationDetector> {
    const dir = join(tempRoot, `epdf-osd-${randomUUID()}`)
    try {
      await store.stageInto(dir, [OSD_PACK.code])
      const mod = (await import('tesseract.js')) as Tess
      const T = mod.default ?? mod
      let fail: (e: Error) => void = () => undefined
      let ready = false
      const failed = new Promise<never>((_, reject) => (fail = reject))
      const started = T.createWorker(OSD_PACK.code, T.OEM?.TESSERACT_ONLY ?? 0, {
        langPath: dir,
        workerPath: tesseractWorkerPath(),
        gzip: false,
        cacheMethod: 'none',
        workerBlobURL: false,
        legacyCore: true,
        legacyLang: true,
        errorHandler: (e: unknown) => {
          if (!ready) fail(new Error(String(e)))
        },
        logger: () => undefined
      })
      const worker = await Promise.race([started, failed])
      ready = true
      return new OrientationDetector(worker, dir)
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      throw new Error(`Page orientation detection could not start: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** How far to turn the picture clockwise so its text is upright; null when there is no confident answer. */
  async detect(image: Uint8Array): Promise<OrientationResult> {
    try {
      const r = await this.worker.detect(Buffer.from(image.buffer, image.byteOffset, image.byteLength))
      return interpretOsd(r?.data)
    } catch {
      return null // a page Tesseract cannot analyse (too little text): recognize it as it is
    }
  }

  async terminate(): Promise<void> {
    await this.worker.terminate().catch(() => undefined)
    await rm(this.dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** tesseract.js' detect() data -> the turn to apply, or null. */
export function interpretOsd(data: { orientation_degrees?: number | null; orientation_confidence?: number | null } | null | undefined): OrientationResult {
  const deg = data?.orientation_degrees
  const conf = data?.orientation_confidence
  if (typeof deg !== 'number' || typeof conf !== 'number' || !Number.isFinite(conf)) return null
  const d = (((Math.round(deg / 90) * 90) % 360) + 360) % 360
  if (d !== 0 && conf < ORIENTATION_CONFIDENCE) return null
  return { degrees: d as 0 | 90 | 180 | 270, confidence: conf }
}
