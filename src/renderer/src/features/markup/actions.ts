import { EditError, editPdf } from '../../edit/session'
import { askConfirm } from '../../state/confirm'
import { errorMessage, notify } from '../../state/notify'
import { useUi } from '../../state/ui'
import { useAnnots, refreshAnnots } from './data'
import { hexToRgb } from './pdf/basics'
import type { Pt, Rect } from './pdf/geometry'
import { subtypeLabel, type AnnotInfo, type ReviewState } from './pdf/model'
import {
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
  type Patch
} from './pdf/ops'
import type { Quad } from './pdf/quads'
import { useMarkup, type TextMarkupKind } from './store'

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
