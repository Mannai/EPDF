import type { PDFDocument } from 'pdf-lib'
import type { DestTail } from '@shared/features/destinations'
import { askConfirm } from '../../state/confirm'
import { xyzTail, targetToPdfPoint } from '../bookmarks/nav'
import { hexToRgb } from '../markup/pdf/basics'
import type { Rect } from '../markup/pdf/geometry'
import { announce, runEdit } from './common'
import { refreshLinks, useLinks } from './data'
import { INVISIBLE_BORDER, type LinkBorder, type LinkInfo, type LinkTargetInput } from './pdf/model'
import { LinkError, addLinks, deleteLink, moveLink, removeAllLinks, resizeLink, updateLink, type NewLink } from './pdf/ops'
import { useLinkUi, type BorderStyle, type LinkForm, type LinkRegion } from './store'

/**
 * Glue between the links UI and the pure link operations: each user action is one `editPdf` call (one undo
 * step), failures become toasts, successes are announced to screen readers.
 */

const run = <T>(docId: string, label: string, fn: (pdf: PDFDocument) => Promise<T> | T): Promise<T | undefined> => runEdit(docId, label, fn, (e) => e instanceof LinkError)

export function borderOf(style: BorderStyle, color: string): LinkBorder {
  if (style === 'none') return INVISIBLE_BORDER
  const [r, g, b] = hexToRgb(color)
  return { width: 1, dashed: style === 'dashed', color: [r, g, b] }
}

export function styleOfBorder(b: LinkBorder): { style: BorderStyle; color: string } {
  if (b.width <= 0) return { style: 'none', color: useLinkUi.getState().newColor }
  const c = b.color ?? [0, 0, 0]
  return { style: b.dashed ? 'dashed' : 'thin', color: `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}` }
}

/** The target the form describes, evaluated against the live document (positions need the page's geometry). */
export function targetFromForm(pdf: PDFDocument, form: LinkForm): LinkTargetInput | null {
  if (form.kind === 'uri') return { kind: 'uri', uri: form.uri }
  if (form.kind === 'named') return { kind: 'named', name: form.named }
  const pageIndex = form.page - 1
  const page = pdf.getPages()[pageIndex]
  if (!page) throw new LinkError(`Page ${form.page} does not exist.`)
  let tail: DestTail
  switch (form.view) {
    case 'fit':
      tail = ['Fit']
      break
    case 'fitwidth':
      tail = ['FitH', targetToPdfPoint(page, { fx: 0, fy: form.pos?.fy ?? 0 })[1]]
      break
    case 'position':
      tail = xyzTail(page, form.pos ?? { fx: 0, fy: 0 })
      break
    default: // 'top' (and 'keep' for a page that was changed)
      tail = xyzTail(page, { fx: 0, fy: 0 })
  }
  return { kind: 'page', pageIndex, tail }
}

export async function createLinks(docId: string, regions: LinkRegion[], form: LinkForm): Promise<boolean> {
  const border = borderOf(form.border, form.color)
  const ids = await run(docId, regions.length > 1 ? 'Add links' : 'Add link', (pdf) => {
    const target = targetFromForm(pdf, form)!
    return addLinks(
      pdf,
      regions.map((r) => ({ pageIndex: r.pageIndex, spec: { rect: r.rect, quads: r.quads, target, border, contents: form.contents } as NewLink }))
    )
  })
  if (!ids) return false
  void refreshLinks(docId)
  useLinkUi.getState().select(docId, ids[0])
  announce(ids.length > 1 ? `${ids.length} links added` : `Link added on page ${regions[0].pageIndex + 1}`)
  return true
}

/** Applies the dialog's values to an existing link (only what changed is rewritten; foreign actions stay untouched). */
export async function saveLinkEdit(docId: string, original: LinkInfo, form: LinkForm): Promise<boolean> {
  const border = borderOf(form.border, form.color)
  const ok = await run(docId, 'Edit link', (pdf) => {
    const editable = original.target.kind === 'uri' || original.target.kind === 'page' || original.target.kind === 'dead' || original.target.kind === 'none'
    const keepPage = form.kind === 'page' && form.view === 'keep' && original.target.kind === 'page' && original.target.dest.pageIndex === form.page - 1
    const keepUri = form.kind === 'uri' && original.target.kind === 'uri' && original.target.uri === form.uri
    const keepNamed = form.kind === 'named' && original.target.kind === 'page' && original.target.named === form.named
    updateLink(pdf, original.id, {
      target: editable && !keepPage && !keepUri && !keepNamed ? (targetFromForm(pdf, form) ?? undefined) : undefined,
      border: sameBorder(border, original.border) ? undefined : border,
      contents: form.contents !== original.contents ? form.contents : undefined
    })
    return true
  })
  if (ok) announce('Link updated')
  return !!ok
}

const sameBorder = (a: LinkBorder, b: LinkBorder): boolean =>
  a.width === b.width && a.dashed === b.dashed && (a.width === 0 || (a.color ?? [0, 0, 0]).every((v, i) => Math.abs(v - (b.color ?? [0, 0, 0])[i]) < 0.005))

export async function moveLinkAction(docId: string, id: string, dx: number, dy: number): Promise<boolean> {
  return !!(await run(docId, 'Move link', (pdf) => {
    moveLink(pdf, id, dx, dy)
    return true
  }))
}

export async function resizeLinkAction(docId: string, id: string, rect: Rect): Promise<boolean> {
  return !!(await run(docId, 'Resize link', (pdf) => {
    resizeLink(pdf, id, rect)
    return true
  }))
}

export async function restyleLinkAction(docId: string, id: string, border: LinkBorder): Promise<boolean> {
  const ok = await run(docId, 'Change link appearance', (pdf) => {
    updateLink(pdf, id, { border })
    return true
  })
  if (ok) announce('Link appearance changed')
  return !!ok
}

export async function deleteLinkAction(docId: string, id: string): Promise<boolean> {
  const ok = await run(docId, 'Delete link', (pdf) => {
    deleteLink(pdf, id)
    return true
  })
  if (ok) {
    const sel = useLinkUi.getState().selection
    if (sel?.docId === docId && sel.id === id) useLinkUi.getState().select(docId, null)
    announce('Link deleted')
  }
  return !!ok
}

/** Removes every link of a page or of the whole document, after asking. */
export async function removeLinksAction(docId: string, pageIndex?: number): Promise<boolean> {
  const links = useLinks.getState().byDoc[docId]?.links ?? []
  const count = pageIndex === undefined ? links.length : links.filter((l) => l.pageIndex === pageIndex).length
  if (count === 0) {
    announce(pageIndex === undefined ? 'This document has no links' : 'This page has no links')
    return false
  }
  const scope = pageIndex === undefined ? 'this document' : `page ${pageIndex + 1}`
  const answer = await askConfirm({
    title: `Remove all links from ${scope}?`,
    message: `${count} ${count === 1 ? 'link' : 'links'} will be removed, including ones that were in the file already. The text stays. You can undo this.`,
    buttons: [
      { label: `Remove ${count} ${count === 1 ? 'link' : 'links'}`, value: 'remove', variant: 'danger' },
      { label: 'Cancel', value: 'cancel' }
    ],
    cancelValue: 'cancel'
  })
  if (answer !== 'remove') return false
  const n = await run(docId, pageIndex === undefined ? 'Remove all links' : 'Remove links from page', (pdf) => removeAllLinks(pdf, pageIndex))
  if (n === undefined) return false
  useLinkUi.getState().select(docId, null)
  void refreshLinks(docId)
  announce(`${n} ${n === 1 ? 'link' : 'links'} removed`)
  return true
}

/** Adds the reviewed, auto-detected links in one undo step. */
export async function addDetectedLinks(docId: string, items: { pageIndex: number; rect: Rect; url: string }[], style: BorderStyle, color: string): Promise<number | undefined> {
  const border = borderOf(style, color)
  const ids = await run(docId, 'Add detected links', (pdf) =>
    addLinks(
      pdf,
      items.map((i) => ({ pageIndex: i.pageIndex, spec: { rect: i.rect, target: { kind: 'uri', uri: i.url }, border } }))
    )
  )
  if (!ids) return undefined
  void refreshLinks(docId)
  announce(`${ids.length} ${ids.length === 1 ? 'link' : 'links'} added`)
  return ids.length
}
