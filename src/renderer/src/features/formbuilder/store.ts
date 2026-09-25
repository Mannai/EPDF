import { create } from 'zustand'
import type { DetectKind, DetectResult, Proposal } from './logic/detect'
import type { BuilderKind, FieldInfo, URect } from './logic/spec'
import type { PageTabInfo } from './logic/tabs'

/** Everything the form builder's UI shares: the fields of the open document, the selection, the review of detected fields... */

export const PANEL_ID = 'formbuilder.panel'
export const TOOL_PREFIX = 'formbuilder.'

export type PanelMode = 'fields' | 'detect' | 'taborder'

export interface DocBuilder {
  /** `<loadSeq>:<contentSeq>` this model was read from. */
  key: string
  fields: FieldInfo[]
  tabs: PageTabInfo[]
  error?: string
  /** The document is protected and the user did not unlock it. */
  locked: boolean
}

export interface DetectState {
  docId: string
  phase: 'running' | 'review' | 'applying'
  progress: { done: number; total: number }
  results: DetectResult[]
  /** Proposals still in play (rejected ones are gone). Rectangles are in the visual frame and can be adjusted. */
  items: Proposal[]
  /** Ids of the items the user marked (for "create selected" / "reject selected"). */
  selected: string[]
  threshold: number
  kinds: Record<DetectKind, boolean>
  cancelRequested: boolean
}

export interface TabOrderState {
  docId: string
  pageIndex: number
  /** The working order (widget keys). */
  keys: string[]
  /** The order in the document when the editor was opened / last applied. */
  saved: string[]
  focusKey: string | null
}

export interface DetectScope {
  open: boolean
  scope: 'current' | 'all' | 'range'
  range: string
}

export interface ClipboardEntry {
  info: FieldInfo
  sourcePage: number
}

interface BuilderState {
  docs: Record<string, DocBuilder>
  mode: PanelMode
  selectionDoc: string | null
  /** Widget keys (`<field name>#<widget index>`). */
  selection: string[]
  clipboard: ClipboardEntry[] | null
  /** Radio tool: the group the next drawn buttons join (null = the next one starts a new group). */
  radioGroup: string | null
  /** Rectangles just committed (user space) shown until the reloaded model arrives. */
  optimistic: Record<string, Record<string, URect>>
  detect: DetectState | null
  detectScope: DetectScope
  taborder: TabOrderState | null
  /** Bumped to ask the properties form to focus its Name box. */
  focusName: number
  setDoc(docId: string, d: DocBuilder | null): void
  setMode(m: PanelMode): void
  select(docId: string, keys: string[]): void
  toggleKey(docId: string, key: string): void
  setClipboard(c: ClipboardEntry[] | null): void
  setRadioGroup(name: string | null): void
  setOptimistic(docId: string, rects: Record<string, URect>): void
  clearOptimistic(docId: string): void
  setDetect(d: DetectState | null): void
  patchDetect(p: Partial<DetectState>): void
  setDetectScope(p: Partial<DetectScope>): void
  setTabOrder(t: TabOrderState | null): void
  requestNameFocus(): void
}

export const useBuilder = create<BuilderState>((set) => ({
  docs: {},
  mode: 'fields',
  selectionDoc: null,
  selection: [],
  clipboard: null,
  radioGroup: null,
  optimistic: {},
  detect: null,
  detectScope: { open: false, scope: 'current', range: '' },
  taborder: null,
  focusName: 0,
  setDoc: (docId, d) =>
    set((s) => {
      const docs = { ...s.docs }
      if (d) docs[docId] = d
      else delete docs[docId]
      return { docs }
    }),
  setMode: (mode) => set({ mode }),
  select: (docId, keys) => set({ selectionDoc: docId, selection: keys }),
  toggleKey: (docId, key) =>
    set((s) => {
      const cur = s.selectionDoc === docId ? s.selection : []
      return { selectionDoc: docId, selection: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] }
    }),
  setClipboard: (clipboard) => set({ clipboard }),
  setRadioGroup: (radioGroup) => set({ radioGroup }),
  setOptimistic: (docId, rects) => set((s) => ({ optimistic: { ...s.optimistic, [docId]: { ...s.optimistic[docId], ...rects } } })),
  clearOptimistic: (docId) =>
    set((s) => {
      if (!s.optimistic[docId]) return s
      const { [docId]: _gone, ...rest } = s.optimistic
      return { optimistic: rest }
    }),
  setDetect: (detect) => set({ detect }),
  patchDetect: (p) => set((s) => (s.detect ? { detect: { ...s.detect, ...p } } : s)),
  setDetectScope: (p) => set((s) => ({ detectScope: { ...s.detectScope, ...p } })),
  setTabOrder: (taborder) => set({ taborder }),
  requestNameFocus: () => set((s) => ({ focusName: s.focusName + 1 }))
}))

/** A stable empty selection: selectors must not return a fresh array each time (it would loop the renderer). */
export const NO_KEYS: string[] = []

export const widgetKey = (name: string, index: number): string => `${name}#${index}`
export const splitKey = (key: string): { name: string; index: number } => {
  const i = key.lastIndexOf('#')
  return { name: key.slice(0, i), index: Number(key.slice(i + 1)) }
}

/** The tools ribbon entries that draw a new field. */
export const CREATE_TOOLS: Record<string, BuilderKind | 'date'> = {
  'formbuilder.text': 'text',
  'formbuilder.checkbox': 'checkbox',
  'formbuilder.radio': 'radio',
  'formbuilder.dropdown': 'dropdown',
  'formbuilder.list': 'list',
  'formbuilder.date': 'date',
  'formbuilder.signature': 'signature',
  'formbuilder.button': 'button'
}
export const SELECT_TOOL = 'formbuilder.select'

/** Fields of the selection, in selection order (the first one is the "primary" one shown in the panel). */
export function selectedWidgets(doc: DocBuilder | undefined, keys: string[]): { field: FieldInfo; index: number; key: string }[] {
  if (!doc) return []
  const out: { field: FieldInfo; index: number; key: string }[] = []
  for (const key of keys) {
    const { name, index } = splitKey(key)
    const field = doc.fields.find((f) => f.name === name)
    if (field && field.widgets.some((w) => w.index === index)) out.push({ field, index, key })
  }
  return out
}
