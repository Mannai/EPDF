import { create } from 'zustand'
import type { LinkInfo, Quad, Rect } from './pdf/model'

/** View state of the links feature (not part of the document). */

export const LINK_TOOL = { add: 'links.add', edit: 'links.edit' } as const

export type BorderStyle = 'none' | 'thin' | 'dashed'

export interface LinkRegion {
  pageIndex: number
  rect: Rect
  quads: Quad[]
}

/** How a link to a page opens it. `keep` (editing only) leaves the file's own destination values alone. */
export type PageView = 'keep' | 'top' | 'fit' | 'fitwidth' | 'position'

export interface LinkForm {
  kind: 'uri' | 'page' | 'named'
  uri: string
  /** 1-based target page. */
  page: number
  view: PageView
  /** A position picked on the target page, as fractions of the displayed page from its top-left. */
  pos: { fx: number; fy: number } | null
  named: string
  border: BorderStyle
  color: string
  contents: string
}

export const DEFAULT_LINK_COLOR = '#0050cc'

export const defaultForm = (): LinkForm => ({
  kind: 'uri',
  uri: '',
  page: 1,
  view: 'top',
  pos: null,
  named: '',
  border: 'none',
  color: DEFAULT_LINK_COLOR,
  contents: ''
})

export type LinkDialogState = { mode: 'create'; docId: string; regions: LinkRegion[] } | { mode: 'edit'; docId: string; link: LinkInfo }

interface LinkUi {
  /** Show every link of the page as an outline (also on while a link tool is active). */
  highlight: boolean
  selection: { docId: string; id: string } | null
  dialog: LinkDialogState | null
  form: LinkForm
  /** The dialog is hidden while the user picks a target position on a page. */
  picking: boolean
  /** Default appearance for new links (from the tool options). */
  newBorder: BorderStyle
  newColor: string
  detect: { docId: string } | null
  setHighlight(v: boolean): void
  select(docId: string, id: string | null): void
  openDialog(d: LinkDialogState, form: LinkForm): void
  closeDialog(): void
  patchForm(p: Partial<LinkForm>): void
  setPicking(v: boolean): void
  setNewBorder(b: BorderStyle): void
  setNewColor(c: string): void
  openDetect(docId: string | null): void
}

export const useLinkUi = create<LinkUi>((set) => ({
  highlight: false,
  selection: null,
  dialog: null,
  form: defaultForm(),
  picking: false,
  newBorder: 'none',
  newColor: DEFAULT_LINK_COLOR,
  detect: null,
  setHighlight: (highlight) => set({ highlight }),
  select: (docId, id) => set({ selection: id ? { docId, id } : null }),
  openDialog: (dialog, form) => set({ dialog, form, picking: false }),
  closeDialog: () => set({ dialog: null, picking: false }),
  patchForm: (p) => set((s) => ({ form: { ...s.form, ...p } })),
  setPicking: (picking) => set({ picking }),
  setNewBorder: (newBorder) => set({ newBorder }),
  setNewColor: (newColor) => set({ newColor }),
  openDetect: (docId) => set({ detect: docId ? { docId } : null })
}))
