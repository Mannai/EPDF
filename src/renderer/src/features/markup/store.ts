import { create } from 'zustand'
import { AUTHOR_FALLBACK, resolveAuthor } from './pdf/basics'
import type { Pt, Rect } from './pdf/geometry'
import { NO_FILTERS, type Filters } from './pdf/threads'

/** UI state of the Comments and markup feature (tool options, selection, drafts, author). */

export const TOOL = {
  select: 'markup.select',
  highlight: 'markup.highlight',
  underline: 'markup.underline',
  strikeout: 'markup.strikeout',
  squiggly: 'markup.squiggly',
  note: 'markup.note',
  textbox: 'markup.textbox',
  ink: 'markup.ink',
  rect: 'markup.rect',
  ellipse: 'markup.ellipse',
  line: 'markup.line',
  arrow: 'markup.arrow',
  stamp: 'markup.stamp'
} as const

export type TextMarkupKind = 'highlight' | 'underline' | 'strikeout' | 'squiggly'

export interface CustomStamp {
  name: string
  kind: 'png' | 'jpg'
  bytes: Uint8Array
}

export interface Options {
  textMarkup: Record<TextMarkupKind, { color: string; opacity: number }>
  note: { color: string; icon: 'Note' | 'Comment' }
  textbox: { color: string; size: number; fill: string | null; border: number }
  ink: { color: string; width: number; opacity: number; smoothing: number }
  shape: { color: string; fill: string | null; width: number; opacity: number; dashed: boolean }
  stamp: { name: string; custom: CustomStamp | null; useCustom: boolean }
}

export const DEFAULT_OPTIONS: Options = {
  textMarkup: {
    highlight: { color: '#ffe100', opacity: 0.7 },
    underline: { color: '#d32f2f', opacity: 1 },
    strikeout: { color: '#d32f2f', opacity: 1 },
    squiggly: { color: '#2e7d32', opacity: 1 }
  },
  note: { color: '#ffd633', icon: 'Note' },
  textbox: { color: '#000000', size: 12, fill: null, border: 1 },
  ink: { color: '#1a56db', width: 2, opacity: 1, smoothing: 0.5 },
  shape: { color: '#d32f2f', fill: null, width: 2, opacity: 1, dashed: false },
  stamp: { name: 'Approved', custom: null, useCustom: false }
}

/** A note or text box that is being typed but not yet in the document. */
export type Draft =
  | { kind: 'note'; docId: string; pageIndex: number; at: Pt }
  | { kind: 'textbox'; docId: string; pageIndex: number; rect: Rect }

const AUTHOR_KEY = 'epdf.markup.author'

function storedAuthor(): string | null {
  try {
    return localStorage.getItem(AUTHOR_KEY)
  } catch {
    return null
  }
}

interface MarkupState {
  /** The author written into new annotations (already resolved: never empty). */
  author: string
  /** The OS user name from main (default when nothing is stored). */
  systemAuthor: string
  setAuthor(name: string): void
  setSystemAuthor(name: string): void

  options: Options
  patchOptions<K extends keyof Options>(key: K, patch: Partial<Options[K]>): void
  patchTextMarkup(kind: TextMarkupKind, patch: Partial<Options['textMarkup'][TextMarkupKind]>): void

  selection: { docId: string; id: string } | null
  /** Bumped to ask the selected annotation's frame to scroll into view (once). */
  reveal: { id: string; seq: number } | null
  select(docId: string, id: string | null, opts?: { reveal?: boolean }): void
  consumeReveal(): void

  draft: Draft | null
  setDraft(d: Draft | null): void

  filters: Filters
  setFilters(f: Partial<Filters>): void
  /** Bumped to move keyboard focus to the selected comment's text field in the panel. */
  focusText: number
  requestFocusText(): void
}

export const useMarkup = create<MarkupState>((set, get) => ({
  author: resolveAuthor(storedAuthor(), ''),
  systemAuthor: '',
  setAuthor: (name) => {
    const clean = name.trim()
    try {
      if (clean) localStorage.setItem(AUTHOR_KEY, clean)
      else localStorage.removeItem(AUTHOR_KEY)
    } catch {
      /* storage unavailable: the name lasts for this session only */
    }
    set({ author: resolveAuthor(clean, get().systemAuthor) })
  },
  setSystemAuthor: (systemAuthor) => set({ systemAuthor, author: resolveAuthor(storedAuthor(), systemAuthor) }),

  options: DEFAULT_OPTIONS,
  patchOptions: (key, patch) => set((s) => ({ options: { ...s.options, [key]: { ...s.options[key], ...patch } } })),
  patchTextMarkup: (kind, patch) =>
    set((s) => ({ options: { ...s.options, textMarkup: { ...s.options.textMarkup, [kind]: { ...s.options.textMarkup[kind], ...patch } } } })),

  selection: null,
  reveal: null,
  select: (docId, id, opts) =>
    set((s) => ({
      selection: id ? { docId, id } : null,
      reveal: id && opts?.reveal ? { id, seq: (s.reveal?.seq ?? 0) + 1 } : null
    })),
  consumeReveal: () => set({ reveal: null }),

  draft: null,
  setDraft: (draft) => set({ draft }),

  filters: NO_FILTERS,
  setFilters: (f) => set((s) => ({ filters: { ...s.filters, ...f } })),
  focusText: 0,
  requestFocusText: () => set((s) => ({ focusText: s.focusText + 1 }))
}))

export const authorOrFallback = (): string => useMarkup.getState().author || AUTHOR_FALLBACK
