import { create } from 'zustand'
import { editPdf } from '../../edit/session'
import { errorMessage, notify } from '../../state/notify'
import { loadUnicodeFont } from './fontClient'
import type { FieldModel, FieldValue, FormModel } from './model'
import { applyFieldValue, validateValue } from './values'

export interface DocForms {
  /** `<loadSeq>:<contentSeq>` this model was read from. */
  key: string
  model: FormModel | null
  /** The document is password protected: pdf-lib can't edit it, so the form stays read-only. */
  encrypted: boolean
}

interface Override {
  value: FieldValue
  version: number
}

interface FormsState {
  docs: Record<string, DocForms>
  /** Values the user just committed that the reloaded document has not caught up with yet. */
  overrides: Record<string, Record<string, Override>>
  highlight: boolean
  bannerDismissed: Record<string, boolean>
  /** A widget to focus as soon as it is rendered (Tab across pages). */
  pendingFocus: { docId: string; key: string } | null
  setDoc(docId: string, d: DocForms | null): void
  toggleHighlight(): void
  dismissBanner(docId: string): void
  setPendingFocus(p: { docId: string; key: string } | null): void
}

let overrideVersion = 0
export const currentOverrideVersion = (): number => overrideVersion

export const useForms = create<FormsState>((set) => ({
  docs: {},
  overrides: {},
  highlight: false,
  bannerDismissed: {},
  pendingFocus: null,
  setDoc: (docId, d) =>
    set((s) => {
      const docs = { ...s.docs }
      if (d) docs[docId] = d
      else delete docs[docId]
      return { docs }
    }),
  toggleHighlight: () => set((s) => ({ highlight: !s.highlight })),
  dismissBanner: (docId) => set((s) => ({ bannerDismissed: { ...s.bannerDismissed, [docId]: true } })),
  setPendingFocus: (pendingFocus) => set({ pendingFocus })
}))

function setOverride(docId: string, name: string, value: FieldValue): number {
  const version = ++overrideVersion
  useForms.setState((s) => ({ overrides: { ...s.overrides, [docId]: { ...s.overrides[docId], [name]: { value, version } } } }))
  return version
}

function dropOverride(docId: string, name: string, version: number): void {
  useForms.setState((s) => {
    const cur = s.overrides[docId]?.[name]
    if (!cur || cur.version !== version) return s
    const { [name]: _gone, ...rest } = s.overrides[docId]
    return { overrides: { ...s.overrides, [docId]: rest } }
  })
}

/** Drops every override committed up to `version` (the reloaded model now includes them). */
export function settleOverrides(docId: string, version: number): void {
  useForms.setState((s) => {
    const cur = s.overrides[docId]
    if (!cur) return s
    const rest = Object.fromEntries(Object.entries(cur).filter(([, o]) => o.version > version))
    return { overrides: { ...s.overrides, [docId]: rest } }
  })
}

/** What the field currently shows: a just-committed value, else the document's. */
export const effectiveValue = (overrides: Record<string, Override> | undefined, f: FieldModel): FieldValue => overrides?.[f.name]?.value ?? f.value

const same = (a: FieldValue, b: FieldValue): boolean => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b)

/**
 * Commits one completed field edit as ONE undo step ("Undo Fill “Name”"). Validation errors and
 * problems (encrypted document, characters no bundled font can draw) are reported with a toast and
 * leave the document untouched. Resolves true if the document was changed.
 */
export async function commitField(docId: string, field: FieldModel, value: FieldValue): Promise<boolean> {
  const cur = effectiveValue(useForms.getState().overrides[docId], field)
  const res = validateValue(field, value)
  if (!res.ok) {
    notify('error', res.error)
    return false
  }
  if (same(res.value, cur)) return false
  const version = setOverride(docId, field.name, res.value)
  try {
    await editPdf(docId, `Fill “${field.label.length > 40 ? field.label.slice(0, 39) + '…' : field.label}”`, (pdf) =>
      applyFieldValue(pdf, field.name, res.value, loadUnicodeFont)
    )
    return true
  } catch (err) {
    dropOverride(docId, field.name, version)
    notify('error', errorMessage(err))
    return false
  }
}
