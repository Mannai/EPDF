import { create } from 'zustand'
import type { Rect } from './pdfcontent/matrix'

export type Scope = 'line' | 'paragraph'

/** The text block currently open in the inline editor. */
export interface TextEditing {
  docId: string
  pageIndex: number
  blockId: string
  level: Scope
  oldText: string
  text: string
  /** Font size in points (user space): current value and the value the block had. */
  size: number
  origSize: number
  color: string
  origColor: string
  /** How the editor should look. */
  fontFamily: string
  bold: boolean
  italic: boolean
  /** Geometry of the block in user space (kept so the editor survives content reloads). */
  bbox: Rect
  firstLine: Rect
  /** Baseline distance in points (0 for a single line) and number of lines. */
  leading: number
  lineCount: number
}

interface TextEditState {
  scope: Scope
  editing: TextEditing | null
  busy: boolean
  setScope(s: Scope): void
  begin(e: TextEditing): void
  patch(p: Partial<Pick<TextEditing, 'text' | 'size' | 'color'>>): void
  end(): void
  setBusy(b: boolean): void
}

export const useTextEdit = create<TextEditState>((set) => ({
  scope: 'line',
  editing: null,
  busy: false,
  setScope: (scope) => set({ scope, editing: null }),
  begin: (editing) => set({ editing }),
  patch: (p) => set((s) => (s.editing ? { editing: { ...s.editing, ...p } } : s)),
  end: () => set({ editing: null }),
  setBusy: (busy) => set({ busy })
}))

export const isTextEditChanged = (e: TextEditing): boolean =>
  e.text !== e.oldText || Math.abs(e.size - e.origSize) > 0.005 || e.color.toLowerCase() !== e.origColor.toLowerCase()
