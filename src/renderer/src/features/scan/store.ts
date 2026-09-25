import { create } from 'zustand'
import type { ScanPreset } from '@shared/features/scan/enhance'
import type { Quad } from '@shared/features/scan/geometry'
import type { PaperChoice } from '@shared/features/scan/pipeline'

/** State of the Scan to PDF dialog. Pixel work lives in the worker (./worker); this is only bookkeeping. */

export type ScanSource = 'scanner' | 'webcam' | 'phone'
export type ScanStep = 'capture' | 'adjust' | 'save'
export type QualityChoice = 'high' | 'balanced' | 'small'

export interface ScanPage {
  id: string
  source: ScanSource
  blob: Blob
  /** Scan resolution when the source knows it (scanners). */
  dpi?: number
  width: number
  height: number
  /** Corners (TL, TR, BR, BL) as fractions of the *rotated* picture; null = the whole picture. */
  quad: Quad | null
  /** Quarter turns clockwise applied before cropping. */
  rotation: number
  state: 'preparing' | 'ready' | 'error'
  error?: string
  /** The page edges could not be found automatically (shown as a hint in the editor). */
  edgesNotFound?: boolean
}

export interface ScanOptions {
  preset: ScanPreset
  straighten: boolean
  paper: PaperChoice
  quality: QualityChoice
  recognize: boolean
}

export interface ResultInfo {
  width: number
  height: number
  pageWidthPt: number
  pageHeightPt: number
  dpi: number
  skewDegrees: number
}

export interface PagePreviews {
  thumb?: ImageBitmap
  view?: ImageBitmap
  result?: ImageBitmap
  resultInfo?: ResultInfo
}

export const DEFAULT_OPTIONS: ScanOptions = { preset: 'color', straighten: true, paper: 'auto', quality: 'balanced', recognize: false }

interface ScanState {
  open: boolean
  step: ScanStep
  tab: ScanSource
  sessionId: string
  pages: ScanPage[]
  selectedId: string | null
  previews: Record<string, PagePreviews>
  options: ScanOptions
  /** A background task in the dialog (assembling the PDF). */
  busy: { label: string; fraction: number } | null
  error: string | null
  /** Polite status text for screen readers. */
  announce: string
  patchPage(id: string, patch: Partial<ScanPage>): void
  setPreviews(id: string, patch: Partial<PagePreviews>): void
}

export const newSessionId = (): string => {
  const b = new Uint8Array(12)
  crypto.getRandomValues(b)
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const useScan = create<ScanState>((set) => ({
  open: false,
  step: 'capture',
  tab: 'scanner',
  sessionId: '',
  pages: [],
  selectedId: null,
  previews: {},
  options: DEFAULT_OPTIONS,
  busy: null,
  error: null,
  announce: '',
  patchPage: (id, patch) => set((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
  setPreviews: (id, patch) => {
    set((s) => {
      const prev = s.previews[id] ?? {}
      // free the bitmaps that are being replaced
      for (const k of ['thumb', 'view', 'result'] as const) {
        if (k in patch && prev[k] && prev[k] !== patch[k]) prev[k]!.close()
      }
      return { previews: { ...s.previews, [id]: { ...prev, ...patch } } }
    })
  }
}))
