import { unzipSync } from 'fflate'
import { DOMParser } from '@xmldom/xmldom'
import type { Block, ImageItem, PageLayout, ParagraphBlock, Run, TableBlock, TableCell } from '../../src/renderer/src/features/export/model'

/** Independent (xmldom, strict) validation of generated OOXML packages, plus synthetic layout builders. */

export type Files = Record<string, Uint8Array>

const dec = new TextDecoder('utf-8', { fatal: true })

export function parseStrict(xml: string, name = 'xml'): Document {
  const errors: string[] = []
  const parser = new DOMParser({
    onError: (level: string, msg: string) => {
      errors.push(`${level}: ${msg}`)
    }
  })
  const doc = parser.parseFromString(xml, 'text/xml')
  if (errors.length) throw new Error(`${name} is not well-formed XML: ${errors.join('; ')}`)
  if (!doc.documentElement) throw new Error(`${name} has no root element`)
  return doc as unknown as Document
}

export function unzip(bytes: Uint8Array): Files {
  return unzipSync(bytes)
}

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'

const dirname = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

function resolveTarget(sourcePart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = (dirname(sourcePart) ? dirname(sourcePart).split('/') : []).concat(target.split('/'))
  const out: string[] = []
  for (const p of parts) {
    if (p === '..') out.pop()
    else if (p !== '.' && p !== '') out.push(p)
  }
  return out.join('/')
}

export interface Checked {
  files: Files
  docs: Record<string, Document>
  /** relationship type -> list of resolved targets, per source part. */
  rels: Record<string, { id: string; type: string; target: string; external: boolean }[]>
}

/** Structural OPC checks: content types cover every part, every internal relationship resolves, every XML part parses. */
export function checkPackage(bytes: Uint8Array): Checked {
  const files = unzip(bytes)
  const names = Object.keys(files)
  if (names[0] !== '[Content_Types].xml') throw new Error(`[Content_Types].xml must be the first entry (got ${names[0]})`)
  const docs: Record<string, Document> = {}
  for (const n of names) if (/\.(xml|rels)$/.test(n)) docs[n] = parseStrict(dec.decode(files[n]), n)

  const ct = docs['[Content_Types].xml']
  if (ct.documentElement.namespaceURI !== CT_NS) throw new Error('Content types namespace is wrong')
  const defaults = new Map<string, string>()
  const overrides = new Map<string, string>()
  for (const d of Array.from(ct.getElementsByTagName('Default'))) defaults.set(d.getAttribute('Extension')!.toLowerCase(), d.getAttribute('ContentType')!)
  for (const o of Array.from(ct.getElementsByTagName('Override'))) overrides.set(o.getAttribute('PartName')!, o.getAttribute('ContentType')!)
  for (const part of overrides.keys()) if (!files[part.slice(1)]) throw new Error(`Override for a missing part: ${part}`)
  for (const n of names) {
    if (n === '[Content_Types].xml') continue
    const ext = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1).toLowerCase() : ''
    if (!overrides.has('/' + n) && !defaults.has(ext)) throw new Error(`No content type for part ${n}`)
  }

  const rels: Checked['rels'] = {}
  for (const n of names.filter((x) => x.endsWith('.rels'))) {
    const d = docs[n]
    if (d.documentElement.namespaceURI !== RELS_NS) throw new Error(`${n}: wrong relationships namespace`)
    const source = n === '_rels/.rels' ? '' : n.replace(/_rels\/([^/]+)\.rels$/, '$1')
    const sourcePath = n === '_rels/.rels' ? '' : source
    if (n !== '_rels/.rels' && !files[sourcePath]) throw new Error(`${n} belongs to a missing part ${sourcePath}`)
    const ids = new Set<string>()
    rels[sourcePath] = []
    for (const r of Array.from(d.getElementsByTagName('Relationship'))) {
      const id = r.getAttribute('Id')!
      if (ids.has(id)) throw new Error(`${n}: duplicate relationship id ${id}`)
      ids.add(id)
      const external = r.getAttribute('TargetMode') === 'External'
      const target = external ? r.getAttribute('Target')! : resolveTarget(sourcePath, r.getAttribute('Target')!)
      if (!external && !files[target]) throw new Error(`${n}: relationship ${id} points to a missing part ${target}`)
      rels[sourcePath].push({ id, type: r.getAttribute('Type')!, target, external })
    }
  }
  const root = rels['']?.find((r) => r.type.endsWith('/officeDocument'))
  if (!root) throw new Error('_rels/.rels has no officeDocument relationship')
  return { files, docs, rels }
}

/** Text content of every element with this namespace + local name, in document order. */
export function textsOf(doc: Document, ns: string, local: string): string[] {
  return Array.from(doc.getElementsByTagNameNS(ns, local)).map((e) => e.textContent ?? '')
}

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  x: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
}

// ---------------------------------------------------------------------------------------------------
// Synthetic layouts
// ---------------------------------------------------------------------------------------------------

export const run = (text: string, o: Partial<Run> = {}): Run => ({ text, size: 11, family: 'Arial', bold: false, italic: false, color: '000000', ...o })

export function para(text: string | Run[], o: Partial<ParagraphBlock> = {}): ParagraphBlock {
  const runs = typeof text === 'string' ? [run(text)] : text
  return {
    type: 'paragraph',
    runs,
    align: 'left',
    indentLeft: 0,
    firstLine: 0,
    spaceBefore: 0,
    pitch: 13,
    heading: 0,
    x: 72,
    y: 72,
    width: 300,
    height: 14,
    lineCount: 1,
    srcLines: [[runs.map((r) => r.text).join('')]],
    ...o
  }
}

export function cell(text: string, o: Partial<TableCell> = {}): TableCell {
  return { runs: text ? [run(text)] : [], text, align: 'left', bold: false, ...o }
}

export function table(rows: string[][], o: Partial<TableBlock> = {}): TableBlock {
  const colW = 100
  return {
    type: 'table',
    colEdges: Array.from({ length: (rows[0]?.length ?? 0) + 1 }, (_, i) => 72 + i * colW),
    rowEdges: Array.from({ length: rows.length + 1 }, (_, i) => 200 + i * 20),
    rows: rows.map((r) => r.map((t) => cell(t))),
    bordered: true,
    x: 72,
    y: 200,
    width: (rows[0]?.length ?? 0) * colW,
    height: rows.length * 20,
    spaceBefore: 0,
    ...o
  }
}

export function image(o: Partial<ImageItem> = {}, seed = 1): ImageItem {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, 0, 0, 0])
  return { x: 72, y: 300, width: 120, height: 60, png, pxWidth: 12, pxHeight: 6, ...o }
}

export function page(number: number, blocks: Block[], o: Partial<PageLayout> = {}): PageLayout {
  return { number, width: 612, height: 792, blocks, margins: { top: 72, right: 72, bottom: 72, left: 72 }, rects: [], ...o }
}
