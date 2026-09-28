import { PDFDocument } from 'pdf-lib'
import { EditError, currentBytes, editPdf } from '../../edit/session'
import { askConfirm } from '../../state/confirm'
import { confirmDelete } from '../../state/confirmDelete'
import { errorMessage, notify } from '../../state/notify'
import { useUi } from '../../state/ui'
import { useAnnots, refreshAnnots } from './data'
import { hexToRgb } from './pdf/basics'
import type { Pt, Rect } from './pdf/geometry'
import { describeAnnot, subtypeLabel, type AnnotInfo, type ReviewState } from './pdf/model'
import { listLocated } from './pdf/annots'
import { copyAnnotation, pasteAnnotation, type AnnotClip } from './pdf/clipboard'
import { normalizeRect } from './pdf/geometry'
import { getNumbers } from './pdf/pdfobj'
import {
  addFillMark,
  addFillSignature,
  addFillText,
  addFreeText,
  addImageStamp,
  addInk,
  addLine,
  addNote,
  addReply,
  addShape,
  addStamp,
  addTextMarkup,
  deleteAnnotation,
  moveAnnotation,
  resizeAnnotation,
  setReviewState,
  updateAnnotation,
  type FillMarkKind,
  type Patch
} from './pdf/ops'
import type { Quad } from './pdf/quads'
import { TOOL, useMarkup, type TextMarkupKind } from './store'
import { useWorkspace } from '../../state/workspace'

/**
 * Glue between the UI and the pure operations: each user action is one `editPdf` call, hence one undo
 * step, with failures reported as toasts and successes announced to screen readers.
 */

let announceFlip = false
export function announce(msg: string): void {
  announceFlip = !announceFlip
  useUi.getState().announce(msg + (announceFlip ? '' : ' ')) // a changed string is re-read by the live region
}

const who = (): { author: string } => ({ author: useMarkup.getState().author })

/** Runs an edit; returns its result, or undefined after reporting why it failed. */
async function run<T>(docId: string, label: string, fn: (pdf: Parameters<Parameters<typeof editPdf>[2]>[0]) => Promise<T> | T): Promise<T | undefined> {
  let out: T | undefined
  try {
    await editPdf(docId, label, async (pdf) => {
      out = await fn(pdf)
    })
    void refreshAnnots(docId)
    return out
  } catch (err) {
    notify('error', err instanceof EditError ? err.message : `Couldn’t ${label.charAt(0).toLowerCase()}${label.slice(1)}: ${errorMessage(err)}`)
    return undefined
  }
}

export const TEXT_MARKUP: Record<TextMarkupKind, { subtype: 'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly'; label: string }> = {
  highlight: { subtype: 'Highlight', label: 'highlight' },
  underline: { subtype: 'Underline', label: 'underline' },
  strikeout: { subtype: 'StrikeOut', label: 'strikethrough' },
  squiggly: { subtype: 'Squiggly', label: 'squiggly underline' }
}

/** Adds text markup for a selection that may span several pages (one undo step). */
export async function createTextMarkup(docId: string, kind: TextMarkupKind, groups: { pageIndex: number; quads: Quad[] }[]): Promise<boolean> {
  const o = useMarkup.getState().options.textMarkup[kind]
  const def = TEXT_MARKUP[kind]
  const ids = await run(docId, `Add ${def.label}`, async (pdf) => {
    const made: string[] = []
    for (const g of groups) {
      made.push(await addTextMarkup(pdf, g.pageIndex, { ...who(), subtype: def.subtype, quads: g.quads, color: hexToRgb(o.color), opacity: o.opacity }))
    }
    return made
  })
  if (!ids) return false
  const pages = groups.map((g) => g.pageIndex + 1)
  const cap = def.label.charAt(0).toUpperCase() + def.label.slice(1)
  announce(`${cap} added on page ${pages.length > 1 ? `${pages[0]} to ${pages[pages.length - 1]}` : pages[0]}`)
  return true
}

export async function createNote(docId: string, pageIndex: number, center: Pt, contents: string): Promise<string | undefined> {
  const o = useMarkup.getState().options.note
  const id = await run(docId, 'Add sticky note', (pdf) => addNote(pdf, pageIndex, { ...who(), center, contents, color: hexToRgb(o.color), icon: o.icon }))
  if (id) announce(`Sticky note added on page ${pageIndex + 1}`)
  return id
}

export async function createTextBox(docId: string, pageIndex: number, rect: Rect, text: string): Promise<string | undefined> {
  const o = useMarkup.getState().options.textbox
  const id = await run(docId, 'Add text box', (pdf) =>
    addFreeText(pdf, pageIndex, {
      ...who(),
      rect,
      text,
      fontSize: o.size,
      color: hexToRgb(o.color),
      fill: o.fill ? hexToRgb(o.fill) : null,
      borderWidth: o.border
    })
  )
  if (id) announce(`Text box added on page ${pageIndex + 1}`)
  return id
}

export async function createInk(docId: string, pageIndex: number, strokes: Pt[][]): Promise<string | undefined> {
  const o = useMarkup.getState().options.ink
  const id = await run(docId, 'Add drawing', (pdf) => addInk(pdf, pageIndex, { ...who(), strokes, color: hexToRgb(o.color), width: o.width, opacity: o.opacity }))
  if (id) announce(`Drawing added on page ${pageIndex + 1}`)
  return id
}

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow'
const SHAPE_LABEL: Record<ShapeKind, string> = { rect: 'rectangle', ellipse: 'ellipse', line: 'line', arrow: 'arrow' }

export async function createShape(docId: string, pageIndex: number, kind: ShapeKind, a: Pt, b: Pt): Promise<string | undefined> {
  const o = useMarkup.getState().options.shape
  const common = { ...who(), color: hexToRgb(o.color), width: o.width, opacity: o.opacity, dashed: o.dashed }
  const id = await run(docId, `Add ${SHAPE_LABEL[kind]}`, (pdf) =>
    kind === 'line' || kind === 'arrow'
      ? addLine(pdf, pageIndex, { ...common, from: a, to: b, arrow: kind === 'arrow' })
      : addShape(pdf, pageIndex, {
          ...common,
          kind: kind === 'rect' ? 'Square' : 'Circle',
          rect: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])],
          fill: o.fill ? hexToRgb(o.fill) : null
        })
  )
  if (id) announce(`${SHAPE_LABEL[kind].charAt(0).toUpperCase()}${SHAPE_LABEL[kind].slice(1)} added on page ${pageIndex + 1}`)
  return id
}

export async function createStamp(docId: string, pageIndex: number, center: Pt): Promise<string | undefined> {
  const o = useMarkup.getState().options.stamp
  const id = await run(docId, 'Add stamp', (pdf) =>
    o.useCustom && o.custom
      ? addImageStamp(pdf, pageIndex, { ...who(), kind: o.custom.kind, bytes: o.custom.bytes, label: o.custom.name, center })
      : addStamp(pdf, pageIndex, { ...who(), name: o.name, center })
  )
  if (id) announce(`Stamp added on page ${pageIndex + 1}`)
  return id
}

// ---------------------------------------------------------------- Fill & sign items

const MARK_LABEL: Record<FillMarkKind, string> = { check: 'check mark', cross: 'cross', dot: 'dot' }

/** Check / cross / dot centred on `center` (PDF user space), `size` points. */
export async function createFillMark(docId: string, pageIndex: number, kind: FillMarkKind, center: Pt, size: number, colorHex: string): Promise<string | undefined> {
  const id = await run(docId, `Add ${MARK_LABEL[kind]}`, (pdf) => addFillMark(pdf, pageIndex, { ...who(), kind, center, size, color: hexToRgb(colorHex) }))
  if (id) announce(`${MARK_LABEL[kind].charAt(0).toUpperCase()}${MARK_LABEL[kind].slice(1)} added on page ${pageIndex + 1}`)
  return id
}

/** Typed text (or a date) in `rect` (PDF user space). */
export async function createFillText(docId: string, pageIndex: number, rect: Rect, text: string, size: number, colorHex: string, label = 'Add text'): Promise<string | undefined> {
  const id = await run(docId, label, (pdf) => addFillText(pdf, pageIndex, { ...who(), rect, text, size, color: hexToRgb(colorHex) }))
  if (id) announce(`${label === 'Add date' ? 'Date' : 'Text'} added on page ${pageIndex + 1}`)
  return id
}

/** A signature (and, optionally, a date under it) as one undo step; returns the signature's id. */
export async function createFillSignature(
  docId: string,
  pageIndex: number,
  o: { png: Uint8Array; center: Pt; width: number; initials: boolean; date?: { text: string; size: number } }
): Promise<string | undefined> {
  const label = o.initials ? 'Add initials' : 'Sign'
  const id = await run(docId, label, async (pdf) => {
    const sig = await addFillSignature(pdf, pageIndex, { ...who(), png: o.png, center: o.center, width: o.width, label: o.initials ? 'Initials' : 'Signature' })
    if (o.date) {
      // Under the signature's left edge (as the reader sees the page).
      const r = listLocated(pdf).find((l) => l.id === sig)!
      const [x0, y0, x1] = normalizeRect(getNumbers(r.dict, 'Rect') as Rect)
      const h = o.date.size * 1.5
      await addFillText(pdf, pageIndex, { ...who(), rect: [x0, y0 - h - 2, Math.max(x1, x0 + o.date.size * 9), y0 - 2], text: o.date.text, size: o.date.size, color: [0, 0, 0] })
    }
    return sig
  })
  if (id) announce(`${o.initials ? 'Initials' : 'Signature'} placed on page ${pageIndex + 1}`)
  return id
}

/**
 * A shape, stamp or text box was just placed: select it with the Select tool, so its handles and properties show and
 * it can be moved, resized, restyled or deleted right away (Acrobat does the same). "Keep tool selected" skips this.
 */
export function selectPlaced(docId: string, id: string | undefined): void {
  if (!id || useMarkup.getState().keepTool) return
  useWorkspace.getState().setActiveTool(TOOL.select, docId)
  useMarkup.getState().select(docId, id)
}

// ---------------------------------------------------------------- copy and paste

/** What Ctrl+C copied, and how often it was pasted (each paste on the same page lands a little further on). */
let clip: { item: AnnotClip; docId: string; pageIndex: number; pastes: number } | null = null
const PASTE_STEP = 12

export const hasCopiedItem = (): boolean => !!clip
export const forgetCopiedItem = (): void => {
  clip = null
}

/** Ctrl+C on a selected item on a page. */
export async function copyAnnot(docId: string, a: Pick<AnnotInfo, 'id' | 'pageIndex'>): Promise<boolean> {
  try {
    const bytes = await currentBytes(docId)
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false })
    clip = { item: await copyAnnotation(pdf, a.id), docId, pageIndex: a.pageIndex, pastes: 0 }
    announce('Copied.')
    return true
  } catch (err) {
    notify('error', `Couldn’t copy this item: ${errorMessage(err)}`)
    return false
  }
}

/**
 * Ctrl+V: pastes the copied item onto `pageIndex` of `docId` and selects it. On the page it came from, each paste is
 * offset down and to the right, so copies don't hide each other; on another page it keeps its position.
 */
export async function pasteAnnot(docId: string, pageIndex: number): Promise<string | undefined> {
  const c = clip
  if (!c) return undefined
  const samePlace = c.docId === docId && c.pageIndex === pageIndex
  const step = samePlace ? (c.pastes + 1) * PASTE_STEP : 0
  const id = await run(docId, 'Paste', (pdf) => pasteAnnotation(pdf, pageIndex, c.item, step, -step))
  if (!id) return undefined
  if (samePlace) c.pastes++
  useMarkup.getState().select(docId, id)
  announce('Pasted.')
  return id
}

// ---------------------------------------------------------------- editing existing annotations

export async function editAnnotation(docId: string, id: string, patch: Patch, label = 'Edit annotation'): Promise<boolean> {
  const ok = await run(docId, label, async (pdf) => {
    await updateAnnotation(pdf, id, patch)
    return true
  })
  return !!ok
}

export const editComment = (docId: string, id: string, contents: string): Promise<boolean> => editAnnotation(docId, id, { contents }, 'Edit comment')

export async function moveAnnot(docId: string, id: string, dx: number, dy: number): Promise<boolean> {
  return !!(await run(docId, 'Move annotation', (pdf) => {
    moveAnnotation(pdf, id, dx, dy)
    return true
  }))
}

export async function resizeAnnot(docId: string, id: string, rect: Rect): Promise<boolean> {
  return !!(await run(docId, 'Resize annotation', async (pdf) => {
    await resizeAnnotation(pdf, id, rect)
    return true
  }))
}

export async function replyTo(docId: string, parentId: string, text: string): Promise<string | undefined> {
  const id = await run(docId, 'Add reply', (pdf) => addReply(pdf, parentId, { ...who(), text }))
  if (id) announce('Reply added')
  return id
}

export async function setStatus(docId: string, id: string, state: ReviewState): Promise<boolean> {
  const label = state === 'Completed' ? 'Resolve comment' : state === 'None' ? 'Reopen comment' : `Mark comment ${state.toLowerCase()}`
  const ok = await run(docId, label, (pdf) => {
    setReviewState(pdf, id, state, who())
    return true
  })
  if (ok) announce(state === 'Completed' ? 'Comment resolved' : state === 'None' ? 'Comment reopened' : `Comment marked ${state.toLowerCase()}`)
  return !!ok
}

/** Delete / Backspace on the selected annotation: asks first (unless turned off), then deletes. */
export async function deleteAnnotByKey(docId: string, a: Pick<AnnotInfo, 'id' | 'subtype'> & Partial<Pick<AnnotInfo, 'fillSign' | 'iconName'>>): Promise<boolean> {
  const all = useAnnots.getState().byDoc[docId]?.annots ?? []
  const what = describeAnnot({ iconName: '', ...a }).toLowerCase()
  // A thread has its own, more specific question in deleteAnnot.
  if (countThread(all, a.id) === 0 && !(await confirmDelete(`this ${what}`))) return false
  return deleteAnnot(docId, a)
}

/** Deletes an annotation; asks first when it has replies (the whole thread goes). */
export async function deleteAnnot(docId: string, a: Pick<AnnotInfo, 'id' | 'subtype'>, opts: { confirmThread?: boolean } = {}): Promise<boolean> {
  const all = useAnnots.getState().byDoc[docId]?.annots ?? []
  const replies = countThread(all, a.id)
  if (replies > 0 && opts.confirmThread !== false) {
    const answer = await askConfirm({
      title: 'Delete this comment thread?',
      message: `This ${subtypeLabel(a.subtype).toLowerCase()} has ${replies} ${replies === 1 ? 'reply or status change' : 'replies and status changes'}. They will be deleted too.`,
      buttons: [
        { label: 'Delete thread', value: 'delete', variant: 'danger' },
        { label: 'Cancel', value: 'cancel' }
      ],
      cancelValue: 'cancel'
    })
    if (answer !== 'delete') return false
  }
  const ok = await run(docId, replies > 0 ? 'Delete comment thread' : `Delete ${subtypeLabel(a.subtype).toLowerCase()}`, (pdf) => {
    deleteAnnotation(pdf, a.id)
    return true
  })
  if (ok) {
    const sel = useMarkup.getState().selection
    if (sel?.docId === docId && sel.id === a.id) useMarkup.getState().select(docId, null)
    announce(`${subtypeLabel(a.subtype)} deleted`)
  }
  return !!ok
}

function countThread(all: AnnotInfo[], id: string): number {
  const children = new Map<string, string[]>()
  for (const a of all) if (a.irt) children.set(a.irt, [...(children.get(a.irt) ?? []), a.id])
  let n = 0
  const stack = [...(children.get(id) ?? [])]
  const seen = new Set<string>([id])
  while (stack.length) {
    const cur = stack.pop()!
    if (seen.has(cur)) continue
    seen.add(cur)
    n++
    stack.push(...(children.get(cur) ?? []))
  }
  return n
}
