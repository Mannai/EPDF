import { create } from 'zustand'

export type PageDialogKind = 'insert' | 'blank' | 'extract' | 'delete' | 'rotate' | 'split'

export interface PageDialogPreset {
  /** 0-based pages the dialog starts with (the organizer's selection, or the current page). */
  pages?: number[]
}

interface PageDialogState {
  kind: PageDialogKind | null
  docId: string | null
  preset: PageDialogPreset
  open(kind: PageDialogKind, docId: string, preset?: PageDialogPreset): void
  close(): void
}

/** Which page-tool dialog is showing, and for which document. The dialogs are hosted once (see Dialogs.tsx). */
export const usePageDialog = create<PageDialogState>((set) => ({
  kind: null,
  docId: null,
  preset: {},
  open: (kind, docId, preset = {}) => set({ kind, docId, preset }),
  close: () => set({ kind: null, docId: null, preset: {} })
}))

interface OrganizerSelectionState {
  /** 0-based selected pages of each document while its organizer is open (read by commands such as Rotate). */
  byDoc: Record<string, number[]>
  set(docId: string, pages: number[] | null): void
}

export const useOrganizerSelection = create<OrganizerSelectionState>((set) => ({
  byDoc: {},
  set: (docId, pages) =>
    set((s) => {
      const next = { ...s.byDoc }
      if (pages && pages.length) next[docId] = pages
      else delete next[docId]
      return { byDoc: next }
    })
}))

const ZOOM_KEY = 'epdf.organizer.thumbWidth'
export const MIN_THUMB = 90
export const MAX_THUMB = 280
export const DEFAULT_THUMB = 150

export function loadThumbWidth(): number {
  try {
    const v = Number(localStorage.getItem(ZOOM_KEY))
    if (Number.isFinite(v) && v >= MIN_THUMB && v <= MAX_THUMB) return v
  } catch {
    /* storage unavailable: fall back to the default */
  }
  return DEFAULT_THUMB
}

export function saveThumbWidth(v: number): void {
  try {
    localStorage.setItem(ZOOM_KEY, String(v))
  } catch {
    /* ignore */
  }
}
