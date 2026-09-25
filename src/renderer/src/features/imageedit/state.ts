import { create } from 'zustand'
import type { Picture } from '../textedit/pdfcontent/imageEdit'
import type { Rect } from '../textedit/pdfcontent/matrix'

export interface SelectedImage {
  docId: string
  pageIndex: number
  /** Analysis id of the image, or '' right after an edit (re-resolved from the box). */
  id: string
  /** Bounding box in user space (points). */
  bbox: Rect
  /** Can be resized (axis-aligned). */
  resizable: boolean
  name: string
  editable: boolean
}

export interface PendingImage {
  docId: string
  picture: Picture
  name: string
  width: number
  height: number
}

interface ImageEditState {
  selected: SelectedImage | null
  pending: PendingImage | null
  mode: 'fit' | 'fill'
  busy: boolean
  /** Bumped by "Place at page center". */
  centerRequest: number
  select(s: SelectedImage | null): void
  setPending(p: PendingImage | null): void
  setMode(m: 'fit' | 'fill'): void
  setBusy(b: boolean): void
  requestCenter(): void
}

export const useImageEdit = create<ImageEditState>((set) => ({
  selected: null,
  pending: null,
  mode: 'fit',
  busy: false,
  centerRequest: 0,
  select: (selected) => set({ selected }),
  setPending: (pending) => set({ pending }),
  setMode: (mode) => set({ mode }),
  setBusy: (busy) => set({ busy }),
  requestCenter: () => set((s) => ({ centerRequest: s.centerRequest + 1 }))
}))
