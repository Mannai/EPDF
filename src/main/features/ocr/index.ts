import { app } from 'electron'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import {
  AddPageRequestSchema,
  BeginRequestSchema,
  DownloadJobSchema,
  EndRequestSchema,
  findPack,
  formatBytes,
  LanguagesRequestSchema,
  OCR_CHANNELS,
  OCR_JOBS,
  OrientationRequestSchema,
  OSD_PACK,
  RemoveLanguageRequestSchema,
  RunJobSchema,
  sanitizePrefs,
  SetPrefsRequestSchema,
  TESSDATA_BASE_URL,
  type BeginResponse,
  type LanguagesResponse,
  type OcrPageResult,
  type OrientationResult
} from '../../../shared/features/ocr'
import { commandItem, contributeMenu } from '../../menu/contributions'
import type { MainContext } from '../api'
import { registerFeatureChannel } from '../api'
import { downloadLanguage } from './download'
import { LanguageStore } from './languages'
import { OrientationDetector } from './orientation'
import { runOcrJob } from './runJob'
import { SessionRegistry } from './session'

/**
 * Main half of OCR: language packs (bundled English + on-demand downloads), the recognition job and the
 * channels the renderer uses to stream page pictures in. All file-system and network access is here; the
 * renderer only ever names languages from the catalogue and never supplies a path or a URL.
 */

export function register(ctx: MainContext): void {
  const kv = ctx.kv('ocr')
  const packaged = app.isPackaged

  // Test-only overrides (ignored in packaged builds): a local server instead of GitHub, and hashes to match
  // the fake packs it serves. Nothing the renderer sends can influence either.
  const baseUrl = !packaged && process.env['EPDF_OCR_BASE_URL'] ? process.env['EPDF_OCR_BASE_URL'] : TESSDATA_BASE_URL
  const hashOverrides = !packaged && process.env['EPDF_OCR_TEST_HASHES'] ? (JSON.parse(process.env['EPDF_OCR_TEST_HASHES']) as Record<string, string>) : undefined
  const allowHttp = !packaged && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(baseUrl)

  const store = new LanguageStore({
    bundledDir: packaged ? join(process.resourcesPath, 'ocr') : join(app.getAppPath(), 'resources', 'ocr'),
    userDir: join(app.getPath('userData'), 'ocr-languages'),
    hashOverrides
  })
  void store.sweepPartials()
  const sessions = new SessionRegistry()
  const workerCount = (total: number): number => {
    const env = Number(process.env['EPDF_OCR_WORKERS'])
    const wanted = Number.isInteger(env) && env > 0 ? env : Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)))
    return Math.max(1, Math.min(wanted, total))
  }

  // ---- languages & preferences ------------------------------------------------------------------------
  const languagesResponse = async (): Promise<LanguagesResponse> => ({
    languages: await store.list(),
    orientation: await store.status(OSD_PACK.code),
    prefs: sanitizePrefs(kv.get('prefs', null))
  })
  registerFeatureChannel(OCR_CHANNELS.languages, LanguagesRequestSchema, () => languagesResponse())
  registerFeatureChannel(OCR_CHANNELS.setPrefs, SetPrefsRequestSchema, (p) => {
    kv.set('prefs', sanitizePrefs(p))
  })
  registerFeatureChannel(OCR_CHANNELS.removeLanguage, RemoveLanguageRequestSchema, async ({ language }) => {
    await store.remove(language)
    return languagesResponse()
  })

  // ---- downloading a language pack --------------------------------------------------------------------
  const downloading = new Set<string>()
  ctx.jobs.register(OCR_JOBS.download, 'Downloading language data', DownloadJobSchema, async ({ language }, job) => {
    const lang = findPack(language)!
    if (lang.bundled) throw new Error(`${lang.name} is part of Epdf; there is nothing to download.`)
    if (downloading.has(language)) throw new Error(`${lang.name} is already being downloaded.`)
    downloading.add(language)
    try {
      job.progress(0, `${lang.name}: connecting`)
      await downloadLanguage({
        lang,
        sha256: store.expectedHash(lang),
        baseUrl,
        destDir: store.userDir,
        signal: job.signal,
        allowHttp,
        onProgress: (got, total) => job.progress(total ? got / total : 0, `${lang.name}: ${formatBytes(got)} of ${formatBytes(total)}`),
        onState: (s) => {
          if (s === 'verifying') job.progress(0.99, `${lang.name}: checking`)
        }
      })
      return { language }
    } finally {
      downloading.delete(language)
    }
  })

  // ---- recognition ------------------------------------------------------------------------------------
  registerFeatureChannel(OCR_CHANNELS.begin, BeginRequestSchema, async ({ languages, total, mayRetry, orient }): Promise<BeginResponse> => {
    for (const code of languages) await store.verify(code) // fail early, with a clear message, before any page is drawn
    if (orient) await store.verify(OSD_PACK.code)
    const s = sessions.create(languages, total, mayRetry === true, orient === true)
    return { sessionId: s.id, parallel: workerCount(total) }
  })

  registerFeatureChannel(OCR_CHANNELS.addPage, AddPageRequestSchema, async ({ sessionId, index, image, retry }): Promise<OcrPageResult> => {
    const s = sessions.get(sessionId)
    if (!s) throw new Error('This recognition run is no longer active.')
    return s.add(index, image, retry === true)
  })

  // Page orientation of one picture, with the run's detector (started on first use, stopped when the run ends).
  registerFeatureChannel(OCR_CHANNELS.orientation, OrientationRequestSchema, async ({ sessionId, image }): Promise<OrientationResult> => {
    const s = sessions.get(sessionId)
    if (!s || s.isClosed) throw new Error('This recognition run is no longer active.')
    if (!s.orient) throw new Error('This recognition run did not ask for page orientation.')
    if (!s.detector) {
      s.detector = OrientationDetector.create(store, app.getPath('temp'))
      const d = s.detector
      s.onClose(async () => (await d.catch(() => null))?.terminate())
    }
    return (await s.detector).detect(image)
  })

  registerFeatureChannel(OCR_CHANNELS.end, EndRequestSchema, ({ sessionId }) => {
    const s = sessions.get(sessionId)
    if (!s) return
    s.end()
    // A run whose job has not started yet keeps its entry (the job looks it up); the job drops it when it finishes.
    if (s.started) sessions.drop(sessionId)
  })

  ctx.jobs.register(OCR_JOBS.run, 'Recognizing text', RunJobSchema, async ({ sessionId }, job) => {
    const session = sessions.get(sessionId)
    if (!session) throw new Error('This recognition run is no longer active.')
    try {
      return await runOcrJob({
        session,
        store,
        tempRoot: app.getPath('temp'),
        workers: workerCount(session.total),
        signal: job.signal,
        progress: job.progress
      })
    } finally {
      sessions.drop(sessionId)
    }
  })

  contributeMenu({
    menu: 'Tools',
    items: () => [commandItem('Recognize Text (OCR)…', 'ocr.run')]
  })
}
