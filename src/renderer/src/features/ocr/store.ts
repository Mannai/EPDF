import { create } from 'zustand'
import {
  DEFAULT_PREFS,
  MAX_LANGUAGES_PER_RUN,
  OCR_CHANNELS,
  OCR_JOBS,
  selectPages,
  type LanguageStatus,
  type LanguagesResponse,
  type OcrPrefs,
  type PageScope
} from '@shared/features/ocr'
import { JobCancelledError, startJob, type JobHandle } from '../../state/jobs'
import { clean, runOcr } from './flow'

/** State of the "Recognize Text (OCR)" dialog: which pages, which languages, options, language downloads. */

export interface DownloadState {
  language: string
  cancel(): void
}

interface OcrUi {
  open: boolean
  docId: string | null
  numPages: number
  currentPage: number
  scopeMode: PageScope['mode']
  rangeText: string
  languages: LanguageStatus[]
  prefs: OcrPrefs
  loading: boolean
  loadError: string | null
  download: DownloadState | null
  downloadError: string | null

  show(docId: string, numPages: number, currentPage: number): Promise<void>
  close(): void
  setScopeMode(m: PageScope['mode']): void
  setRangeText(t: string): void
  toggleLanguage(code: string): void
  setPref<K extends keyof OcrPrefs>(k: K, v: OcrPrefs[K]): void
  downloadLanguage(code: string): Promise<void>
  removeLanguage(code: string): Promise<void>
  start(): Promise<void>
}

export const useOcrUi = create<OcrUi>((set, get) => ({
  open: false,
  docId: null,
  numPages: 0,
  currentPage: 1,
  scopeMode: 'all',
  rangeText: '',
  languages: [],
  prefs: DEFAULT_PREFS,
  loading: false,
  loadError: null,
  download: null,
  downloadError: null,

  show: async (docId, numPages, currentPage) => {
    set({ open: true, docId, numPages, currentPage, scopeMode: 'all', rangeText: '', loading: true, loadError: null, downloadError: null })
    try {
      const r = await window.epdf.call<LanguagesResponse>(OCR_CHANNELS.languages, {})
      set({ languages: r.languages, prefs: r.prefs, loading: false })
    } catch (err) {
      set({ loading: false, loadError: clean(err) })
    }
  },

  close: () => {
    get().download?.cancel()
    set({ open: false, download: null, downloadError: null })
  },

  setScopeMode: (scopeMode) => set({ scopeMode }),
  setRangeText: (rangeText) => set({ rangeText, scopeMode: 'range' }),

  toggleLanguage: (code) =>
    set((s) => {
      const has = s.prefs.languages.includes(code)
      const languages = has ? s.prefs.languages.filter((c) => c !== code) : s.prefs.languages.length >= MAX_LANGUAGES_PER_RUN ? s.prefs.languages : [...s.prefs.languages, code]
      return { prefs: { ...s.prefs, languages } }
    }),

  setPref: (k, v) => set((s) => ({ prefs: { ...s.prefs, [k]: v } })),

  downloadLanguage: async (code) => {
    if (get().download) return
    const handle: JobHandle<unknown> = startJob(OCR_JOBS.download, { language: code })
    set({ download: { language: code, cancel: handle.cancel }, downloadError: null })
    try {
      await handle.promise
      const r = await window.epdf.call<LanguagesResponse>(OCR_CHANNELS.languages, {})
      set({ languages: r.languages })
    } catch (err) {
      if (!(err instanceof JobCancelledError)) set({ downloadError: clean(err) })
    } finally {
      set({ download: null })
    }
  },

  removeLanguage: async (code) => {
    try {
      const r = await window.epdf.call<LanguagesResponse>(OCR_CHANNELS.removeLanguage, { language: code })
      set((s) => ({ languages: r.languages, prefs: { ...s.prefs, languages: s.prefs.languages.filter((c) => c !== code).length ? s.prefs.languages.filter((c) => c !== code) : ['eng'] } }))
    } catch (err) {
      set({ downloadError: clean(err) })
    }
  },

  start: async () => {
    const s = get()
    if (!s.docId) return
    const sel = selectPages(scopeOf(s), s.numPages)
    if (!sel.ok) return
    const docId = s.docId
    const prefs = s.prefs
    void window.epdf.call(OCR_CHANNELS.setPrefs, prefs).catch(() => undefined)
    set({ open: false })
    await runOcr({ docId, pages: sel.pages, languages: prefs.languages, prefs })
  }
}))

export function scopeOf(s: Pick<OcrUi, 'scopeMode' | 'rangeText' | 'currentPage'>): PageScope {
  if (s.scopeMode === 'all') return { mode: 'all' }
  if (s.scopeMode === 'current') return { mode: 'current', page: s.currentPage }
  return { mode: 'range', text: s.rangeText }
}

/** Why the dialog's Recognize button is unavailable (null = ready). */
export function blocker(s: OcrUi): string | null {
  if (s.loading) return 'Loading…'
  if (s.loadError) return s.loadError
  const sel = selectPages(scopeOf(s), s.numPages)
  if (!sel.ok) return sel.error
  if (s.prefs.languages.length === 0) return 'Choose at least one language.'
  const missing = s.prefs.languages.map((c) => s.languages.find((l) => l.code === c)).filter((l) => l && !l.installed)
  if (missing.length) return `Download ${missing.map((l) => l!.name).join(', ')} before recognizing.`
  if (s.download) return 'Wait for the download to finish.'
  return null
}
