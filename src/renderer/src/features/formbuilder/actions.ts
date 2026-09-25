import { PDFDocument } from 'pdf-lib'
import { currentBytes, editPdf, ensureEditable } from '../../edit/session'
import { activeTab } from '../../state/actions'
import { askConfirm } from '../../state/confirm'
import { errorMessage, notify } from '../../state/notify'
import { useTabs } from '../../state/tabs'
import { useUi } from '../../state/ui'
import { useWorkspace } from '../../state/workspace'
import { align, distribute, nudge, resizeBy, sameSize, type AlignMode, type Item } from './logic/align'
import { applyProposals, detectDocument } from './logic/apply'
import { fieldsToCsv } from './logic/csv'
import { cleanLabel, type Proposal } from './logic/detect'
import { BuilderError, applyPatch, clearAllFields, deleteFields, deleteRadioButton, fieldNames, setWidgetRects } from './logic/edit'
import { createField, addRadioButton } from './logic/create'
import { frameForPage } from './logic/frame'
import { nameFor, uniqueName } from './logic/names'
import { readBuilderModel } from './logic/read'
import { DEFAULT_SIZE, NAME_STEM, type BuilderKind, type FieldInfo, type FieldPatch, type FieldSpec, type URect } from './logic/spec'
import { applyTabPreset, readTabInfo, setTabOrder as writeTabOrder } from './logic/tabs'
import { CREATE_TOOLS, SELECT_TOOL, selectedWidgets, splitKey, useBuilder, widgetKey, type DocBuilder } from './store'

/**
 * The builder's operations. Every change goes through `editPdf` (one undo step each), after `ensureEditable`
 * (which may ask for the password of a protected document). Errors become toasts; nothing is half-applied.
 */

const announce = (msg: string): void => useUi.getState().announce(msg)

export async function runEdit(docId: string, label: string, fn: (pdf: PDFDocument) => Promise<void> | void): Promise<boolean> {
  try {
    if (!(await ensureEditable(docId))) {
      notify('info', 'The document is password protected and was not unlocked, so it cannot be changed.')
      return false
    }
    await editPdf(docId, label, fn)
    return true
  } catch (err) {
    notify('error', errorMessage(err))
    return false
  }
}

// ---------------------------------------------------------------------------------------------------------
// reading the document

export async function loadBuilder(docId: string, key: string): Promise<DocBuilder> {
  try {
    if (!(await ensureEditable(docId))) return { key, fields: [], tabs: [], locked: true }
    const pdf = await PDFDocument.load(await currentBytes(docId), { updateMetadata: false })
    const m = readBuilderModel(pdf)
    return { key, fields: m.fields, tabs: readTabInfo(pdf), error: m.error, locked: false }
  } catch (err) {
    return { key, fields: [], tabs: [], error: errorMessage(err), locked: /encrypt|password/i.test(errorMessage(err)) }
  }
}

export const docBuilder = (docId: string): DocBuilder | undefined => useBuilder.getState().docs[docId]

function primaryField(docId: string): FieldInfo | undefined {
  const s = useBuilder.getState()
  return selectedWidgets(s.docs[docId], s.selectionDoc === docId ? s.selection : [])[0]?.field
}

/** The name of the primary selected field when it is of `kind`, else null. */
export function selectedFieldName(docId: string, kind: BuilderKind): string | null {
  const f = primaryField(docId)
  return f && f.kind === kind ? f.name : null
}

export const selectionKeys = (docId: string): string[] => {
  const s = useBuilder.getState()
  return s.selectionDoc === docId ? s.selection : []
}

// ---------------------------------------------------------------------------------------------------------
// creating fields

const DEFAULT_OPTIONS = ['Option 1', 'Option 2', 'Option 3']

/** The style manual fields get: a visible thin border on a white fill (they can be changed in the panel). */
const MANUAL_STYLE = { borderColor: '#1f2328', backgroundColor: '#ffffff', borderWidth: 1 } as const

export async function createManual(docId: string, tool: BuilderKind | 'date', pageIndex: number, rect: URect | { visualCenter: [number, number] }): Promise<string | null> {
  const kind: BuilderKind = tool === 'date' ? 'text' : tool
  let finalName: string | null = null
  let firstKey: string | null = null
  const ok = await runEdit(docId, `Add ${tool === 'date' ? 'date field' : kind === 'radio' ? 'radio button' : kind === 'checkbox' ? 'check box' : kind === 'list' ? 'list box' : `${kind} field`}`, async (pdf) => {
    const page = pdf.getPage(pageIndex)
    let r: URect
    if ('visualCenter' in rect) {
      const f = frameForPage(page)
      const { w, h } = DEFAULT_SIZE[kind]
      const [cx, cy] = rect.visualCenter
      const u = f.boxToUser({ x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 })
      r = { x1: u.x0, y1: u.y0, x2: u.x1, y2: u.y1 }
    } else r = rect
    const taken = new Set(fieldNames(pdf))
    // Radio tool: keep adding buttons to the current group while it exists.
    const group = useBuilder.getState().radioGroup
    if (kind === 'radio' && group && pdf.getForm().getFieldMaybe(group)) {
      const g = pdf.getForm().getRadioGroup(group)
      const used = new Set(g.getOptions())
      let n = used.size + 1
      while (used.has(`Choice${n}`)) n++
      const value = await addRadioButton(pdf, group, pageIndex, r, `Choice${n}`)
      finalName = group
      firstKey = widgetKey(group, g.acroField.getWidgets().length - 1)
      void value
      return
    }
    const name = nameFor(undefined, tool === 'date' ? 'Date' : NAME_STEM[kind], taken)
    const spec: FieldSpec = { kind, name, pageIndex, rect: r, style: { ...MANUAL_STYLE } }
    if (kind === 'dropdown' || kind === 'list') spec.options = [...DEFAULT_OPTIONS]
    if (kind === 'button') spec.caption = 'Button'
    if (kind === 'radio') spec.buttons = [{ rect: r, value: 'Choice1' }]
    if (tool === 'date') spec.format = { type: 'date', format: 'dd/mm/yyyy' }
    if (kind === 'signature') spec.tooltip = 'Signature'
    finalName = await createField(pdf, spec)
    firstKey = widgetKey(finalName, 0)
  })
  if (!ok || !finalName) return null
  useBuilder.getState().select(docId, [firstKey!])
  if (kind === 'radio') useBuilder.getState().setRadioGroup(finalName)
  useBuilder.getState().requestNameFocus()
  announce(`${tool === 'date' ? 'Date field' : kind} “${finalName}” added. Its properties are in the Form fields panel.`)
  return finalName
}

/** Adds a field of `tool` in the middle of the page the user is looking at (the keyboard alternative to drawing). */
export async function addAtCenter(docId: string, tool: BuilderKind | 'date'): Promise<void> {
  const tab = activeTab()
  const pageIndex = Math.max(0, (tab?.docId === docId ? tab.view.page : 1) - 1)
  const doc = docBuilder(docId)
  const onPage = doc ? doc.fields.reduce((n, f) => n + f.widgets.filter((w) => w.pageIndex === pageIndex).length, 0) : 0
  let size: [number, number] = [612, 792]
  try {
    const pdf = await PDFDocument.load(await currentBytes(docId), { updateMetadata: false })
    const f = frameForPage(pdf.getPage(Math.min(pageIndex, pdf.getPageCount() - 1)))
    size = [f.width, f.height]
  } catch {
    /* fall back to Letter */
  }
  const off = (onPage % 12) * 18
  await createManual(docId, tool, pageIndex, { visualCenter: [size[0] / 2 + off - 108, size[1] / 2 - off + 108] })
}

// ---------------------------------------------------------------------------------------------------------
// editing

const labelOf = (names: string[]): string => (names.length === 1 ? `“${names[0]}”` : `${names.length} fields`)

/** Applies a patch to fields by name. After a rename the selection follows the field. */
export async function patchFields(docId: string, names: string[], patch: FieldPatch, label?: string): Promise<boolean> {
  const renamed: Record<string, string> = {}
  const ok = await runEdit(docId, label ?? `Change properties of ${labelOf(names)}`, async (pdf) => {
    for (const n of names) renamed[n] = await applyPatch(pdf, n, patch)
  })
  if (ok && patch.name !== undefined) {
    const st = useBuilder.getState()
    st.select(
      docId,
      st.selection.map((k) => {
        const { name, index } = splitKey(k)
        return renamed[name] ? widgetKey(renamed[name], index) : k
      })
    )
    if (useBuilder.getState().radioGroup && renamed[useBuilder.getState().radioGroup!]) useBuilder.getState().setRadioGroup(renamed[useBuilder.getState().radioGroup!])
  }
  return ok
}

export async function moveWidgets(docId: string, updates: { name: string; index: number; rect: URect }[], label: string): Promise<boolean> {
  useBuilder.getState().setOptimistic(docId, Object.fromEntries(updates.map((u) => [widgetKey(u.name, u.index), u.rect])))
  const ok = await runEdit(docId, label, (pdf) => setWidgetRects(pdf, updates))
  if (!ok) useBuilder.getState().clearOptimistic(docId)
  return ok
}

function itemsFor(docId: string): { items: Item[]; refs: Map<string, { name: string; index: number }> } {
  const s = useBuilder.getState()
  const doc = s.docs[docId]
  const items: Item[] = []
  const refs = new Map<string, { name: string; index: number }>()
  for (const { field, index, key } of selectedWidgets(doc, selectionKeys(docId))) {
    const w = field.widgets.find((x) => x.index === index)!
    const rect = s.optimistic[docId]?.[key] ?? w.rect
    items.push({ id: key, rect, rotation: w.pageRotation })
    refs.set(key, { name: field.name, index })
  }
  return { items, refs }
}

async function commitRects(docId: string, result: Map<string, URect>, refs: Map<string, { name: string; index: number }>, label: string): Promise<boolean> {
  if (result.size === 0) return false
  const updates = [...result].map(([key, rect]) => ({ ...refs.get(key)!, rect }))
  return moveWidgets(docId, updates, label)
}

export async function arrange(docId: string, op: { kind: 'align'; mode: AlignMode } | { kind: 'distribute'; axis: 'horizontal' | 'vertical' } | { kind: 'size'; dim: 'width' | 'height' | 'both' }): Promise<void> {
  const { items, refs } = itemsFor(docId)
  const need = op.kind === 'distribute' ? 3 : 2
  if (items.length < need) {
    notify('info', op.kind === 'distribute' ? 'Select at least three fields to distribute them.' : 'Select at least two fields first (Shift+click adds to the selection).')
    return
  }
  const names: Record<string, string> = {
    left: 'Align left',
    right: 'Align right',
    top: 'Align top',
    bottom: 'Align bottom',
    hcenter: 'Center horizontally',
    vcenter: 'Center vertically'
  }
  if (op.kind === 'align') await commitRects(docId, align(items, op.mode), refs, names[op.mode])
  else if (op.kind === 'distribute') await commitRects(docId, distribute(items, op.axis), refs, `Distribute ${op.axis}ly`)
  else await commitRects(docId, sameSize(items, op.dim), refs, op.dim === 'both' ? 'Same size' : op.dim === 'width' ? 'Same width' : 'Same height')
}

/** Moves the selection by a visual offset in points (right / up positive). */
export async function nudgeSelection(docId: string, dx: number, dy: number): Promise<void> {
  const { items, refs } = itemsFor(docId)
  if (!items.length) return
  await commitRects(docId, nudge(items, dx, dy), refs, `Move ${labelOf([...new Set([...refs.values()].map((r) => r.name))])}`)
}

export async function resizeSelection(docId: string, dx: number, dy: number): Promise<void> {
  const { items, refs } = itemsFor(docId)
  if (!items.length) return
  await commitRects(docId, resizeBy(items, dx, dy), refs, `Resize ${labelOf([...new Set([...refs.values()].map((r) => r.name))])}`)
}

export async function deleteSelection(docId: string): Promise<void> {
  const st = useBuilder.getState()
  const sel = selectedWidgets(st.docs[docId], selectionKeys(docId))
  if (!sel.length) return
  const byField = new Map<string, { field: FieldInfo; indexes: number[] }>()
  for (const s of sel) {
    const e = byField.get(s.field.name) ?? { field: s.field, indexes: [] }
    e.indexes.push(s.index)
    byField.set(s.field.name, e)
  }
  const names = [...byField.keys()]
  const ok = await runEdit(docId, `Delete ${labelOf(names)}`, (pdf) => {
    const whole: string[] = []
    for (const { field, indexes } of byField.values()) {
      if (field.kind === 'radio' && indexes.length < field.widgets.length) [...indexes].sort((a, b) => b - a).forEach((i) => deleteRadioButton(pdf, field.name, i))
      else whole.push(field.name)
    }
    deleteFields(pdf, whole)
  })
  if (ok) {
    useBuilder.getState().select(docId, [])
    announce(`${labelOf(names)} deleted`)
  }
}

// ---------------------------------------------------------------------------------------------------------
// clipboard

export function copySelection(docId: string): void {
  const st = useBuilder.getState()
  const sel = selectedWidgets(st.docs[docId], selectionKeys(docId))
  const fields = new Map<string, FieldInfo>()
  for (const s of sel) fields.set(s.field.name, s.field)
  if (!fields.size) return
  st.setClipboard([...fields.values()].map((info) => ({ info, sourcePage: info.widgets[0]?.pageIndex ?? 0 })))
  announce(`${fields.size === 1 ? '1 field' : `${fields.size} fields`} copied`)
}

function specFromInfo(info: FieldInfo, name: string, pageIndex: number, dx: number, dy: number): FieldSpec {
  const move = (r: URect): URect => ({ x1: r.x1 + dx, y1: r.y1 + dy, x2: r.x2 + dx, y2: r.y2 + dy })
  const w0 = info.widgets[0]
  const spec: FieldSpec = {
    kind: info.kind,
    name,
    pageIndex,
    rect: move(w0.rect),
    tooltip: info.tooltip || undefined,
    required: info.required,
    readOnly: info.readOnly,
    hidden: info.hidden,
    maxLength: info.maxLength,
    multiline: info.multiline,
    password: info.password,
    comb: info.comb,
    options: info.options.length ? [...info.options] : undefined,
    editable: info.editable,
    multiSelect: info.multiSelect,
    onValue: info.kind === 'checkbox' ? info.onValue : undefined,
    caption: info.caption || undefined,
    style: { ...info.style },
    format: info.format,
    value: info.defaultValue || undefined
  }
  if (info.kind === 'radio') spec.buttons = info.widgets.map((w) => ({ rect: move(w.rect), value: w.value ?? 'Choice' }))
  return spec
}

/** Pastes the clipboard onto `pageIndex` (offset a little when it lands on the page it was copied from). */
export async function pasteClipboard(docId: string, pageIndex: number): Promise<void> {
  const clip = useBuilder.getState().clipboard
  if (!clip?.length) {
    notify('info', 'Nothing to paste. Select a field and copy it first.')
    return
  }
  const created: string[] = []
  const ok = await runEdit(docId, clip.length === 1 ? `Paste “${clip[0].info.name}”` : `Paste ${clip.length} fields`, async (pdf) => {
    const taken = new Set(fieldNames(pdf))
    for (const { info, sourcePage } of clip) {
      const same = sourcePage === pageIndex
      const spec = specFromInfo(info, uniqueName(info.name.replace(/\.[^.]*$/, (m) => m.replace('.', '_')), taken), pageIndex, same ? 14 : 0, same ? -14 : 0)
      created.push(await createField(pdf, spec))
    }
  })
  if (ok) {
    useBuilder.getState().select(docId, created.map((n) => widgetKey(n, 0)))
    announce(`${created.length === 1 ? 'Field' : `${created.length} fields`} pasted`)
  }
}

export async function duplicateSelection(docId: string): Promise<void> {
  copySelection(docId)
  const tab = useTabs.getState().tabs.find((t) => t.docId === docId)
  const first = selectedWidgets(docBuilder(docId), selectionKeys(docId))[0]
  await pasteClipboard(docId, first ? first.field.widgets.find((w) => w.index === first.index)!.pageIndex : Math.max(0, (tab?.view.page ?? 1) - 1))
}

// ---------------------------------------------------------------------------------------------------------
// whole-form actions

export async function clearForm(docId: string): Promise<void> {
  let cleared = 0
  const ok = await runEdit(docId, 'Clear form', async (pdf) => {
    cleared = await clearAllFields(pdf)
  })
  if (ok) announce(cleared === 0 ? 'The form was already empty' : `Form cleared: ${cleared} ${cleared === 1 ? 'field' : 'fields'} emptied`)
}

export async function exportCsv(docId: string): Promise<void> {
  try {
    if (!(await ensureEditable(docId))) return
    const pdf = await PDFDocument.load(await currentBytes(docId), { updateMetadata: false })
    const fields = readBuilderModel(pdf).fields
    if (!fields.length) {
      notify('info', 'This document has no form fields to list.')
      return
    }
    const res = await window.epdf.call<{ path: string; name: string } | null>('formbuilder:saveCsv', { docId, text: fieldsToCsv(fields) })
    if (res) notify('success', `Saved the list of ${fields.length} fields to ${res.name}`)
  } catch (err) {
    notify('error', errorMessage(err))
  }
}

// ---------------------------------------------------------------------------------------------------------
// tab order

export function openTabOrder(docId: string, pageIndex?: number): void {
  const doc = docBuilder(docId)
  const pages = doc?.tabs.map((t) => t.pageIndex) ?? []
  if (!pages.length) {
    notify('info', 'Add some form fields first: the tab order is about the order they are visited in.')
    return
  }
  const tab = useTabs.getState().tabs.find((t) => t.docId === docId)
  const wanted = pageIndex ?? (tab ? tab.view.page - 1 : 0)
  const page = pages.includes(wanted) ? wanted : pages[0]
  const info = doc!.tabs.find((t) => t.pageIndex === page)!
  const keys = info.entries.map((e) => e.key)
  useBuilder.getState().setTabOrder({ docId, pageIndex: page, keys, saved: keys, focusKey: keys[0] ?? null })
  useBuilder.getState().setMode('taborder')
  useWorkspace.getState().setRightPanel('formbuilder.panel')
}

export async function applyTabOrder(docId: string): Promise<void> {
  const t = useBuilder.getState().taborder
  if (!t || t.docId !== docId) return
  const ok = await runEdit(docId, `Set tab order of page ${t.pageIndex + 1}`, (pdf) => writeTabOrder(pdf, t.pageIndex, t.keys))
  if (ok) {
    useBuilder.getState().setTabOrder({ ...t, saved: t.keys })
    announce(`Tab order of page ${t.pageIndex + 1} saved`)
  }
}

export async function applyTabPresetAction(docId: string, preset: 'row' | 'column'): Promise<void> {
  const t = useBuilder.getState().taborder
  if (!t || t.docId !== docId) return
  const ok = await runEdit(docId, `Tab order by ${preset === 'row' ? 'rows' : 'columns'}, page ${t.pageIndex + 1}`, (pdf) => applyTabPreset(pdf, t.pageIndex, preset))
  if (ok) {
    // The document reloads; re-read the order the next time the model arrives (see BuilderHost).
    useBuilder.getState().setTabOrder({ ...t, keys: [], saved: [] })
    announce(`Tab order set by ${preset === 'row' ? 'rows' : 'columns'}`)
  }
}

// ---------------------------------------------------------------------------------------------------------
// detection

/** "1-3, 5" -> [0, 1, 2, 4] (0-based); returns null when the text is not a valid page list. */
export function parsePageRange(text: string, numPages: number): number[] | null {
  const out = new Set<number>()
  for (const part of text.split(/[,;]/).map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part)
    if (!m) return null
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    if (a < 1 || b < a || b > numPages) return null
    for (let i = a; i <= b; i++) out.add(i - 1)
  }
  return out.size ? [...out].sort((x, y) => x - y) : null
}

let detectRun = 0

export async function startDetect(docId: string, pages: number[] | 'all'): Promise<void> {
  const run = ++detectRun
  const st = useBuilder.getState()
  st.setMode('detect')
  useWorkspace.getState().setRightPanel('formbuilder.panel')
  st.setDetect({
    docId,
    phase: 'running',
    progress: { done: 0, total: 0 },
    results: [],
    items: [],
    selected: [],
    threshold: 0.5,
    kinds: { text: true, checkbox: true, radio: true, comb: true, date: true, signature: true },
    cancelRequested: false
  })
  try {
    if (!(await ensureEditable(docId))) {
      st.setDetect(null)
      notify('info', 'The document is password protected and was not unlocked, so it cannot be analysed.')
      return
    }
    const pdf = await PDFDocument.load(await currentBytes(docId), { updateMetadata: false })
    const list = pages === 'all' ? undefined : pages
    const results = await detectDocument(pdf, {
      pages: list,
      shouldCancel: () => detectRun !== run || !!useBuilder.getState().detect?.cancelRequested,
      onProgress: (progress) => {
        if (detectRun === run) useBuilder.getState().patchDetect({ progress })
      }
    })
    if (detectRun !== run || useBuilder.getState().detect?.cancelRequested) return
    const items = results.flatMap((r) => r.proposals)
    useBuilder.getState().patchDetect({ phase: 'review', results, items, selected: [], progress: { done: results.length, total: results.length } })
    const shown = items.filter((p) => p.confidence >= 0.5).length
    announce(`Detection finished: ${shown} suggested ${shown === 1 ? 'field' : 'fields'}`)
  } catch (err) {
    useBuilder.getState().setDetect(null)
    notify('error', errorMessage(err))
  }
}

export function cancelDetect(): void {
  detectRun++
  useBuilder.getState().setDetect(null)
  announce('Field detection closed. No fields were added.')
}

export const visibleProposals = (d: { items: Proposal[]; threshold: number; kinds: Record<string, boolean> }): Proposal[] =>
  d.items.filter((p) => p.confidence >= d.threshold && d.kinds[p.kind])

/** Creates real fields for `proposals` as ONE undo step. */
export async function acceptProposals(docId: string, proposals: Proposal[]): Promise<void> {
  const st = useBuilder.getState()
  if (!st.detect || st.detect.docId !== docId || proposals.length === 0) return
  st.patchDetect({ phase: 'applying' })
  let report: { created: string[]; skipped: { name: string; reason: string }[] } = { created: [], skipped: [] }
  const ok = await runEdit(docId, proposals.length === 1 ? `Add form field “${proposals[0].name}”` : `Add ${proposals.length} detected form fields`, async (pdf) => {
    report = await applyProposals(pdf, proposals)
    if (report.created.length === 0 && report.skipped.length) throw new BuilderError(report.skipped[0].reason)
  })
  if (!ok) {
    useBuilder.getState().patchDetect({ phase: 'review' })
    return
  }
  const done = new Set(proposals.map((p) => p.id))
  const rest = useBuilder.getState().detect!.items.filter((p) => !done.has(p.id))
  if (report.skipped.length) notify('error', `${report.skipped.length} suggestion${report.skipped.length === 1 ? '' : 's'} could not be created: ${report.skipped[0].reason}`)
  announce(`${report.created.length} form ${report.created.length === 1 ? 'field' : 'fields'} added`)
  if (rest.filter((p) => p.confidence >= useBuilder.getState().detect!.threshold).length === 0) {
    useBuilder.getState().setDetect(null)
    useBuilder.getState().setMode('fields')
    useWorkspace.getState().setActiveTool(SELECT_TOOL, docId)
    useBuilder.getState().select(docId, report.created.slice(0, 1).map((n) => widgetKey(n, 0)))
  } else useBuilder.getState().patchDetect({ phase: 'review', items: rest, selected: [] })
}

export function updateProposal(id: string, patch: Partial<Proposal>): void {
  const d = useBuilder.getState().detect
  if (!d) return
  useBuilder.getState().patchDetect({ items: d.items.map((p) => (p.id === id ? { ...p, ...patch, label: 'label' in patch ? cleanLabel(patch.label) : p.label } : p)) })
}

export function rejectProposals(ids: string[]): void {
  const d = useBuilder.getState().detect
  if (!d || !ids.length) return
  const set = new Set(ids)
  useBuilder.getState().patchDetect({ items: d.items.filter((p) => !set.has(p.id)), selected: d.selected.filter((s) => !set.has(s)) })
  announce(`${ids.length} suggestion${ids.length === 1 ? '' : 's'} rejected`)
}

// ---------------------------------------------------------------------------------------------------------
// preview

export function enterPreview(docId: string): void {
  useWorkspace.getState().setActiveTool(null, docId)
  useBuilder.getState().select(docId, [])
  announce('Preview mode: fill the form in as a user would. Choose Edit fields to go back.')
}

export function enterEdit(docId: string): void {
  useWorkspace.getState().setActiveTool(SELECT_TOOL, docId)
  useBuilder.getState().setMode('fields')
  useWorkspace.getState().setRightPanel('formbuilder.panel')
}

export const isBuilderTool = (id: string | null): boolean => !!id && id.startsWith('formbuilder.')
export const createKindOf = (id: string | null): (BuilderKind | 'date') | null => (id ? (CREATE_TOOLS[id] ?? null) : null)

/** Confirms before discarding a review that has pending suggestions (used when leaving the mode). */
export async function confirmDiscardReview(): Promise<boolean> {
  const d = useBuilder.getState().detect
  if (!d || d.phase !== 'review' || d.items.length === 0) return true
  const r = await askConfirm({
    title: 'Discard suggestions?',
    message: `${d.items.length} detected ${d.items.length === 1 ? 'field has' : 'fields have'} not been created yet.`,
    buttons: [
      { label: 'Discard', value: 'discard', variant: 'danger' },
      { label: 'Keep reviewing', value: 'keep' }
    ],
    cancelValue: 'keep'
  })
  return r === 'discard'
}
