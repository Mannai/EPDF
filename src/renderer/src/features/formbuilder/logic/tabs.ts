import { PDFArray, PDFDict, PDFName, PDFRef, type PDFDocument } from 'pdf-lib'
import { annotationPages } from '../../forms/model'
import { kindOfField } from './read'
import { BuilderError } from './edit'
import type { BuilderKind, URect } from './spec'

/**
 * Tab order. A page's /Tabs entry says how readers walk its form fields: R = row order, C = column order,
 * S = the order of the page's /Annots array (Epdf's editor uses this for a manual order and reorders /Annots).
 * Reading and writing both are pure pdf-lib.
 */

export type TabsMode = 'R' | 'C' | 'S'

export interface TabEntry {
  /** `<field name>#<widget index>` - the same key the form overlay uses. */
  key: string
  name: string
  index: number
  kind: BuilderKind
  rect: URect
  /** What to call it in the list: tooltip or name, plus the radio button value. */
  label: string
}

export interface PageTabInfo {
  pageIndex: number
  mode: TabsMode | null
  rotation: number
  /** Widgets in /Annots order. */
  entries: TabEntry[]
}

const N = PDFName.of

interface WidgetIndex {
  byRef: Map<string, TabEntry>
}

function indexWidgets(pdf: PDFDocument): WidgetIndex {
  const byRef = new Map<string, TabEntry>()
  for (const f of pdf.getForm().getFields()) {
    const kind = kindOfField(f)
    if (!kind) continue
    const tip = f.acroField.getInheritableAttribute(N('TU'))
    const label = tip && 'decodeText' in tip ? (tip as { decodeText(): string }).decodeText().trim() || f.getName() : f.getName()
    f.acroField.getWidgets().forEach((w, i) => {
      const ref = pdf.context.getObjectRef(w.dict)
      if (!ref) return
      let r = { x: 0, y: 0, width: 0, height: 0 }
      try {
        r = w.getRectangle()
      } catch {
        /* keep zeros */
      }
      byRef.set(ref.tag, {
        key: `${f.getName()}#${i}`,
        name: f.getName(),
        index: i,
        kind,
        label,
        rect: { x1: Math.min(r.x, r.x + r.width), y1: Math.min(r.y, r.y + r.height), x2: Math.max(r.x, r.x + r.width), y2: Math.max(r.y, r.y + r.height) }
      })
    })
  }
  return { byRef }
}

export function readTabsMode(pdf: PDFDocument, pageIndex: number): TabsMode | null {
  const t = pdf.getPage(pageIndex).node.lookup(N('Tabs'))
  const v = t instanceof PDFName ? t.decodeText() : ''
  return v === 'R' || v === 'C' || v === 'S' ? v : null
}

/** For every page that has form widgets: /Tabs and the widgets in /Annots order. */
export function readTabInfo(pdf: PDFDocument): PageTabInfo[] {
  const idx = indexWidgets(pdf)
  const out: PageTabInfo[] = []
  pdf.getPages().forEach((page, pageIndex) => {
    const annots = page.node.Annots()
    const entries: TabEntry[] = []
    if (annots) {
      for (let i = 0; i < annots.size(); i++) {
        const ref = annots.get(i)
        if (!(ref instanceof PDFRef)) continue
        const e = idx.byRef.get(ref.tag)
        if (e) entries.push(e)
      }
    }
    if (entries.length) out.push({ pageIndex, mode: readTabsMode(pdf, pageIndex), rotation: (((page.getRotation().angle % 360) + 360) % 360), entries })
  })
  return out
}

/** Sort keys of a rectangle as the reader sees it: `top` smaller = higher on screen, `left` smaller = further left. */
export function visualPosition(r: URect, rotation: number): { top: number; left: number } {
  switch (rotation) {
    case 90:
      return { top: r.x1, left: r.y1 }
    case 180:
      return { top: r.y1, left: -r.x2 }
    case 270:
      return { top: -r.x2, left: -r.y2 }
    default:
      return { top: -r.y2, left: r.x1 }
  }
}

const ROW_TOL = 3

/** The keys in reading order (`row`: line by line; `column`: column by column). */
export function visualOrder(entries: TabEntry[], rotation: number, mode: 'row' | 'column'): string[] {
  const withPos = entries.map((e) => ({ e, p: visualPosition(e.rect, rotation) }))
  withPos.sort((a, b) => {
    const [pa, pb] = mode === 'row' ? [a.p, b.p] : [{ top: a.p.left, left: a.p.top }, { top: b.p.left, left: b.p.top }]
    if (Math.abs(pa.top - pb.top) > ROW_TOL) return pa.top - pb.top
    return pa.left - pb.left
  })
  return withPos.map((x) => x.e.key)
}

/** Sets a page's /Tabs entry (null removes it). */
export function setPageTabs(pdf: PDFDocument, pageIndex: number, mode: TabsMode | null): void {
  const node = pdf.getPage(pageIndex).node
  if (mode === null) node.delete(N('Tabs'))
  else node.set(N('Tabs'), N(mode))
}

/**
 * Makes Tab visit the widgets of a page in the given order: reorders the widgets inside /Annots (other kinds of
 * annotations keep their places) and sets /Tabs /S. `keys` lists widget keys; widgets not listed keep their
 * relative order after the listed ones.
 */
export function setTabOrder(pdf: PDFDocument, pageIndex: number, keys: string[]): void {
  const page = pdf.getPage(pageIndex)
  const annots = page.node.lookup(N('Annots'))
  if (!(annots instanceof PDFArray)) throw new BuilderError('This page has no form fields.')
  const idx = indexWidgets(pdf)
  const slots: number[] = []
  const byKey = new Map<string, PDFRef>()
  const current: string[] = []
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i)
    if (!(ref instanceof PDFRef)) continue
    const e = idx.byRef.get(ref.tag)
    if (!e) continue
    slots.push(i)
    byKey.set(e.key, ref)
    current.push(e.key)
  }
  const unknown = keys.filter((k) => !byKey.has(k))
  if (unknown.length) throw new BuilderError('A field in the tab order is not on this page any more.')
  const seen = new Set(keys)
  const ordered = [...keys, ...current.filter((k) => !seen.has(k))]
  ordered.forEach((k, i) => annots.set(slots[i], byKey.get(k)!))
  setPageTabs(pdf, pageIndex, 'S')
}

/** Applies a preset: row/column order sets /Tabs and lays /Annots out the same way; `structure` keeps the array. */
export function applyTabPreset(pdf: PDFDocument, pageIndex: number, preset: 'row' | 'column'): void {
  const info = readTabInfo(pdf).find((p) => p.pageIndex === pageIndex)
  if (!info) return
  const keys = visualOrder(info.entries, info.rotation, preset)
  setTabOrder(pdf, pageIndex, keys)
  setPageTabs(pdf, pageIndex, preset === 'row' ? 'R' : 'C')
}

export { annotationPages }
export type { PDFDict }
