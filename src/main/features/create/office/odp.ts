import { OfficeError, throwIfCancelled, type ConvertEnv } from './env'
import type { Block, Cell, Inline, ParaProps, Row, Table, TextStyle } from './flow'
import { DEFAULT_PARA_PROPS } from './flow'
import { dashArray } from './drawingml'
import { shiftOps, stackFragments, tableFragments } from './layout'
import {
  OdfStyles,
  PT_PER_CM,
  applyParaProps,
  applyTextProps,
  baseParaProps,
  baseTextProps,
  odfBorder,
  odfLength,
  toTextStyle,
  type ParaBase,
  type TextProps
} from './odfStyles'
import type { Op, Page, PathSeg, Stroke } from './ops'
import { imageFormat, openPackage, type Pkg } from './package'
import { arrowHeadOps, ellipsePath, layoutTextBlock, mapPath, parseSvgPath, pathBounds, placeholderBox, presetPath, presetTextInset, rectPath, roundRectPath } from './slideShapes'
import { attr, child, descendants, textContent, type XNode } from './xml'

/**
 * ODP -> PDF pages. One page per slide, sized from the master page's page layout. Master-page shapes are
 * drawn under the slide's own shapes; text frames, custom shapes, basic shapes, lines, polygons, paths,
 * pictures, tables and groups are supported. Anything else is replaced by a labelled placeholder and reported.
 */

const DEFAULT_FAMILY = 'Liberation Serif'

interface Box {
  x: number
  y: number
  w: number
  h: number
  /** Clockwise degrees about (x, y). */
  rot: number
}

interface Ctx {
  env: ConvertEnv
  pkg: Pkg
  st: OdfStyles
  slideNo: number
  total: number
  slideW: number
  slideH: number
  flags: { gradient: boolean; hatch: boolean; shadow: boolean }
  /** Frames of the current master page by presentation class (geometry fallback for slide placeholders). */
  masterBoxes: Map<string, Box>
  /** Draw master footer/date/page-number frames (per page style flags). */
  show: { footer: boolean; dateTime: boolean; pageNumber: boolean }
  inMaster: boolean
  /** Numbering state shared by lists that continue each other. */
  counters: Map<string, number[]>
  /** List style of the frame being drawn (from its presentation/graphic style) for lists without their own. */
  defaultList?: XNode
}

export async function convertOdp(bytes: Uint8Array, env: ConvertEnv): Promise<Page[]> {
  const pkg = openPackage(bytes, 'presentation')
  const contentRoot = pkg.xml('content.xml')
  const doc = contentRoot?.children.find((c) => c.name === 'document-content')
  if (!doc) throw new OfficeError('This OpenDocument file has no content (content.xml is missing).')
  const st = new OdfStyles()
  st.addRoot(pkg.xml('styles.xml'))
  st.addRoot(contentRoot)
  const pres = child(child(doc, 'body'), 'presentation')
  if (!pres) throw new OfficeError('This OpenDocument file is not a presentation.')
  const slides = pres.children.filter((c) => c.name === 'page')
  if (slides.length === 0) throw new OfficeError('This presentation has no slides.')
  const flags = { gradient: false, hatch: false, shadow: false }
  const pages: Page[] = []
  for (let i = 0; i < slides.length; i++) {
    throwIfCancelled(env)
    env.progress(i / slides.length, `Slide ${i + 1} of ${slides.length}`)
    const slide = slides[i]
    const styleName = attr(slide, 'style-name')
    const pageProps = st.resolve('drawing-page', styleName).graphic
    if (attr(slide, 'visibility') === 'hidden' || pageProps['visibility'] === 'hidden') {
      env.warnings.add(`Hidden slide ${i + 1} was skipped.`)
      continue
    }
    const master = st.masterPages.get(attr(slide, 'master-page-name') ?? '') ?? [...st.masterPages.values()][0]
    const layout = st.pageLayouts.get(attr(master, 'page-layout-name') ?? '')
    const slideW = odfLength(layout?.page['page-width'], 28 * PT_PER_CM)
    const slideH = odfLength(layout?.page['page-height'], 15.75 * PT_PER_CM)
    const page: Page = { width: slideW, height: slideH, ops: [] }
    const ctx: Ctx = {
      env,
      pkg,
      st,
      slideNo: i + 1,
      total: slides.length,
      slideW,
      slideH,
      flags,
      masterBoxes: new Map(),
      show: { footer: pageProps['display-footer'] === 'true', dateTime: pageProps['display-date-time'] === 'true', pageNumber: pageProps['display-page-number'] === 'true' },
      inMaster: false,
      counters: new Map()
    }
    // collect master placeholder geometry
    for (const f of master?.children ?? []) {
      if (f.name === 'frame' && attr(f, 'class')) {
        const b = shapeBox(f, ctx)
        if (b) ctx.masterBoxes.set(attr(f, 'class')!, b)
      }
    }
    // background
    const masterProps = st.resolve('drawing-page', attr(master, 'style-name')).graphic
    const bgProps = 'fill' in pageProps ? pageProps : masterProps
    if (pageProps['background-visible'] !== 'false') applyBackground(ctx, page, bgProps)
    if (pageProps['background-objects-visible'] !== 'false' && master) {
      ctx.inMaster = true
      for (const n of master.children) renderNode(ctx, n, page.ops)
      ctx.inMaster = false
    }
    for (const n of slide.children) renderNode(ctx, n, page.ops)
    pages.push(page)
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0))
  }
  if (flags.gradient) env.warnings.add('Gradient fills are approximated by a single solid colour.')
  if (flags.hatch) env.warnings.add('Hatch fills are approximated by a solid colour.')
  if (flags.shadow) env.warnings.add('Shadows are not rendered.')
  if (pages.length === 0) throw new OfficeError('Every slide in this presentation is hidden, so there is nothing to convert.')
  return pages
}

// ---------------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------------

/** Parses `draw:transform` ("rotate (a) translate (x y)": applied left to right; angles are counter-clockwise radians). */
export function parseOdfTransform(t: string | undefined): { rot: number; tx: number; ty: number; skew: boolean } {
  let psi = 0 // clockwise radians in y-down space
  let tx = 0
  let ty = 0
  let skew = false
  if (!t) return { rot: 0, tx, ty, skew }
  for (const m of t.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const args = m[2].trim().split(/[\s,]+/).filter(Boolean)
    if (m[1] === 'rotate') {
      const a = -parseFloat(args[0] ?? '0')
      psi += a
      const c = Math.cos(a)
      const s = Math.sin(a)
      const nx = tx * c - ty * s
      ty = tx * s + ty * c
      tx = nx
    } else if (m[1] === 'translate') {
      tx += odfLength(args[0])
      ty += odfLength(args[1] ?? '0')
    } else if (m[1] === 'skewX' || m[1] === 'skewY') skew = true
  }
  return { rot: (psi * 180) / Math.PI, tx, ty, skew }
}

function shapeBox(n: XNode, ctx: Ctx): Box | undefined {
  const tr = parseOdfTransform(attr(n, 'transform'))
  const hasT = !!attr(n, 'transform')
  let w = odfLength(attr(n, 'width'), NaN)
  let h = odfLength(attr(n, 'height'), NaN)
  let x = odfLength(attr(n, 'x'), NaN)
  let y = odfLength(attr(n, 'y'), NaN)
  if (attr(n, 'x1') !== undefined) {
    const x1 = odfLength(attr(n, 'x1'))
    const y1 = odfLength(attr(n, 'y1'))
    const x2 = odfLength(attr(n, 'x2'))
    const y2 = odfLength(attr(n, 'y2'))
    x = Math.min(x1, x2)
    y = Math.min(y1, y2)
    w = Math.abs(x2 - x1)
    h = Math.abs(y2 - y1)
  }
  if (hasT) {
    x = tr.tx + (Number.isFinite(x) ? x : 0)
    y = tr.ty + (Number.isFinite(y) ? y : 0)
  }
  if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(x) || !Number.isFinite(y)) {
    const cls = attr(n, 'class')
    const fb = cls ? ctx.masterBoxes.get(cls) : undefined
    if (fb && !ctx.inMaster) {
      return { x: Number.isFinite(x) ? x : fb.x, y: Number.isFinite(y) ? y : fb.y, w: Number.isFinite(w) ? w : fb.w, h: Number.isFinite(h) ? h : fb.h, rot: tr.rot }
    }
    return undefined
  }
  if (tr.skew) ctx.env.warnings.add(`A skewed shape on slide ${ctx.slideNo} is drawn without the skew.`)
  return { x, y, w, h, rot: tr.rot }
}

function wrapRot(ops: Op[], box: Box, body: Op[]): void {
  if (Math.abs(box.rot) > 0.01) ops.push({ t: 'push', rotate: { deg: box.rot, cx: box.x, cy: box.y } }, ...body, { t: 'pop' })
  else ops.push(...body)
}

// ---------------------------------------------------------------------------------------------------
// Fill / stroke
// ---------------------------------------------------------------------------------------------------

interface FillO {
  color?: { hex: string; alpha: number }
  imageHref?: string
}

const avg = (a: string, b: string): string => {
  const p = (h: string, i: number): number => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
  return '#' + [0, 1, 2].map((i) => Math.round((p(a, i) + p(b, i)) / 2).toString(16).padStart(2, '0')).join('')
}

function opacityOf(gp: Record<string, string>): number {
  const o = gp['opacity']
  if (o) return Math.max(0, Math.min(1, parseFloat(o) / 100))
  const t = gp['transparency']
  if (t) return Math.max(0, Math.min(1, 1 - parseFloat(t) / 100))
  return 1
}

function fillOf(ctx: Ctx, gp: Record<string, string>): FillO | undefined {
  const kind = gp['fill']
  if (!kind || kind === 'none') return undefined
  const alpha = opacityOf(gp)
  if (kind === 'solid') return { color: { hex: (gp['fill-color'] ?? '#729fcf').toLowerCase(), alpha } }
  if (kind === 'gradient') {
    const g = ctx.st.gradients.get(gp['fill-gradient-name'] ?? '')
    ctx.flags.gradient = true
    const a = (attr(g, 'start-color') ?? gp['fill-color'] ?? '#808080').toLowerCase()
    const b = (attr(g, 'end-color') ?? a).toLowerCase()
    return { color: { hex: avg(a, b), alpha } }
  }
  if (kind === 'bitmap') {
    const im = ctx.st.fillImages.get(gp['fill-image-name'] ?? '')
    const href = attr(im, 'href')
    return href ? { imageHref: href } : undefined
  }
  if (kind === 'hatch') {
    ctx.flags.hatch = true
    return { color: { hex: (gp['fill-color'] ?? '#cccccc').toLowerCase(), alpha: 0.5 } }
  }
  return undefined
}

function strokeOf(ctx: Ctx, gp: Record<string, string>): Stroke | undefined {
  const kind = gp['stroke']
  if (!kind || kind === 'none') return undefined
  const width = Math.max(0.5, odfLength(gp['stroke-width'], 0))
  let dash: number[] | undefined
  if (kind === 'dash') {
    const d = ctx.st.dashes.get(gp['stroke-dash'] ?? '')
    const style = attr(d, 'style')
    dash = dashArray(style === 'round' || /dot/i.test(attr(d, 'name') ?? '') ? 'dot' : 'dash', width)
  }
  return { color: (gp['stroke-color'] ?? '#000000').toLowerCase(), width, dash }
}

function applyBackground(ctx: Ctx, page: Page, gp: Record<string, string>): void {
  const f = fillOf(ctx, gp)
  if (!f) return
  if (f.color) page.background = f.color.hex
  else if (f.imageHref) {
    const img = loadImage(ctx, f.imageHref)
    if (img?.ok) page.ops.push({ t: 'image', x: 0, y: 0, w: page.width, h: page.height, image: img.data })
    else ctx.env.warnings.add(`The background picture of slide ${ctx.slideNo} could not be used.`)
  }
}

type Loaded = { ok: true; data: { bytes: Uint8Array; format: 'png' | 'jpeg' } } | { ok: false; fmt: string }

function loadImage(ctx: Ctx, href: string | undefined, node?: XNode): Loaded | undefined {
  let bytes: Uint8Array | undefined
  if (node) {
    const bin = child(node, 'binary-data')
    if (bin) {
      try {
        bytes = new Uint8Array(Buffer.from(textContent(bin).replace(/\s+/g, ''), 'base64'))
      } catch {
        bytes = undefined
      }
    }
  }
  if (!bytes && href) bytes = ctx.pkg.bytes(href.replace(/^\.\//, ''))
  if (!bytes) return undefined
  const fmt = imageFormat(bytes)
  if (fmt === 'png' || fmt === 'jpeg') return { ok: true, data: { bytes, format: fmt } }
  return { ok: false, fmt }
}

// ---------------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------------

const PLACEHOLDER_CLASSES = new Set(['title', 'outline', 'subtitle', 'text', 'graphic', 'object', 'chart', 'table', 'orgchart', 'page', 'notes', 'handout', 'header'])

const TYPE_MAP: Record<string, string> = {
  rectangle: 'rect',
  ellipse: 'ellipse',
  'round-rectangle': 'roundRect',
  diamond: 'diamond',
  'isosceles-triangle': 'triangle',
  'right-triangle': 'rtTriangle',
  parallelogram: 'parallelogram',
  trapezoid: 'trapezoid',
  pentagon: 'pentagon',
  hexagon: 'hexagon',
  octagon: 'octagon',
  'right-arrow': 'rightArrow',
  'left-arrow': 'leftArrow',
  'up-arrow': 'upArrow',
  'down-arrow': 'downArrow',
  star5: 'star5',
  star4: 'star4',
  star6: 'star6',
  chevron: 'chevron',
  cross: 'plus',
  'pentagon-right': 'homePlate',
  'flowchart-process': 'rect',
  'flowchart-alternate-process': 'roundRect',
  'flowchart-decision': 'diamond',
  'flowchart-terminator': 'flowChartTerminator',
  'flowchart-connector': 'ellipse',
  'quad-bevel': 'rect',
  'ring': 'ellipse'
}

function shapeProps(ctx: Ctx, n: XNode): Record<string, string> {
  const g = ctx.st.resolve('graphic', n.attrs['draw:style-name']).graphic
  const presName = n.attrs['presentation:style-name']
  const ps = presName && ctx.st.has('presentation', presName) ? ctx.st.resolve('presentation', presName).graphic : {}
  const merged = { ...g, ...ps }
  if (merged['shadow'] === 'visible') ctx.flags.shadow = true
  return merged
}

function textBase(ctx: Ctx, n: XNode): { tp: TextProps; pb: ParaBase } {
  let tp = baseTextProps()
  let pb = baseParaProps()
  const g = ctx.st.resolve('graphic', n.attrs['draw:style-name'])
  tp = applyTextProps(tp, g.text, ctx.st.fonts)
  pb = applyParaProps(pb, g.para)
  ctx.defaultList = g.nestedList ?? (g.listStyleName ? ctx.st.listStyles.get(g.listStyleName) : undefined)
  const presName = n.attrs['presentation:style-name']
  if (presName && ctx.st.has('presentation', presName)) {
    const p = ctx.st.resolve('presentation', presName)
    tp = applyTextProps(tp, p.text, ctx.st.fonts)
    pb = applyParaProps(pb, p.para)
    ctx.defaultList = p.nestedList ?? (p.listStyleName ? ctx.st.listStyles.get(p.listStyleName) : undefined) ?? ctx.defaultList
  }
  const tsn = n.attrs['draw:text-style-name']
  if (tsn) {
    const t = ctx.st.resolve('paragraph', tsn)
    tp = applyTextProps(tp, t.text, ctx.st.fonts)
    pb = applyParaProps(pb, t.para)
  }
  return { tp, pb }
}

function renderNode(ctx: Ctx, n: XNode, ops: Op[]): void {
  throwIfCancelled(ctx.env)
  switch (n.name) {
    case 'frame':
      return renderFrame(ctx, n, ops)
    case 'custom-shape':
    case 'rect':
    case 'ellipse':
    case 'circle':
    case 'polygon':
    case 'polyline':
    case 'path':
    case 'line':
    case 'connector':
      return renderShape(ctx, n, ops)
    case 'g':
      for (const c of n.children) renderNode(ctx, c, ops)
      return
    case 'caption':
    case 'measure':
    case 'control':
    case 'page-thumbnail':
    case 'regular-polygon': {
      const b = shapeBox(n, ctx)
      ctx.env.warnings.add(`A “${n.name}” object on slide ${ctx.slideNo} is not supported and is shown as a placeholder.`)
      if (b) placeholderBox(ctx.env, ops, b.x, b.y, b.w, b.h, n.name)
      return
    }
    default:
      return
  }
}

function renderShape(ctx: Ctx, n: XNode, ops: Op[]): void {
  const box = shapeBox(n, ctx)
  if (!box) return
  const gp = shapeProps(ctx, n)
  const fill = fillOf(ctx, gp)
  const stroke = strokeOf(ctx, gp)
  const body: Op[] = []
  let paths: PathSeg[][] = []
  let closed = true
  let prstForText = 'rect'
  const rel = (d: PathSeg[]): PathSeg[] => mapPath(d, (x) => x + box.x, (y) => y + box.y)
  switch (n.name) {
    case 'rect': {
      const r = Math.max(odfLength(attr(n, 'corner-radius')), 0)
      paths = [r > 0 ? roundRectPath(box.w, box.h, r) : rectPath(box.w, box.h)]
      break
    }
    case 'ellipse':
    case 'circle':
      paths = [ellipsePath(box.w, box.h)]
      prstForText = 'ellipse'
      break
    case 'custom-shape': {
      const eg = child(n, 'enhanced-geometry')
      const type = (attr(eg, 'type') ?? '').replace(/^ooxml-/, '')
      const prst = TYPE_MAP[type] ?? type
      const pp = presetPath(prst, box.w, box.h, {})
      prstForText = prst
      if (pp) paths = [pp]
      else {
        paths = [rectPath(box.w, box.h)]
        ctx.env.warnings.add(`The shape type “${type || 'custom'}” on slide ${ctx.slideNo} is not supported and is drawn as a rectangle.`)
      }
      break
    }
    case 'polygon':
    case 'polyline':
    case 'path': {
      const vb = (attr(n, 'viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
      let d: PathSeg[]
      if (n.name === 'path') d = parseSvgPath(attr(n, 'd') ?? '')
      else {
        const pts = (attr(n, 'points') ?? '').trim().split(/\s+/).map((p) => p.split(',').map(Number) as [number, number]).filter((p) => p.length === 2 && p.every(Number.isFinite))
        d = pts.map((p, i) => (i === 0 ? (['M', p[0], p[1]] as PathSeg) : (['L', p[0], p[1]] as PathSeg)))
        if (n.name === 'polygon') d.push(['Z'])
      }
      const vw = vb[2] || pathBounds(d).w || 1
      const vh = vb[3] || pathBounds(d).h || 1
      const vx = vb[0] || 0
      const vy = vb[1] || 0
      paths = [mapPath(d, (x) => ((x - vx) * box.w) / vw, (y) => ((y - vy) * box.h) / vh)]
      closed = n.name !== 'polyline' && d.some((s) => s[0] === 'Z')
      break
    }
    case 'line':
    case 'connector': {
      const x1 = odfLength(attr(n, 'x1'))
      const y1 = odfLength(attr(n, 'y1'))
      const x2 = odfLength(attr(n, 'x2'))
      const y2 = odfLength(attr(n, 'y2'))
      const st = stroke ?? { color: '#000000', width: 0.75 }
      if (n.name === 'connector' && attr(n, 'type') && attr(n, 'type') !== 'standard' && attr(n, 'type') !== 'line') ctx.env.warnings.add(`A connector on slide ${ctx.slideNo} is drawn as a straight line.`)
      const d: PathSeg[] = [['M', x1, y1], ['L', x2, y2]]
      body.push({ t: 'path', d, stroke: st })
      const ang = Math.atan2(y2 - y1, x2 - x1)
      if (gp['marker-end']) body.push(...arrowHeadOps(x2, y2, ang, st.width, 'triangle', 'med', st.color, 1))
      if (gp['marker-start']) body.push(...arrowHeadOps(x1, y1, ang + Math.PI, st.width, 'triangle', 'med', st.color, 1))
      wrapRot(ops, { ...box, rot: 0 }, body)
      return
    }
    default:
      return
  }
  for (const d of paths) {
    const f = closed ? fill?.color : undefined
    const pathOp: Op = { t: 'path', d: rel(d), fill: f?.hex, stroke, opacity: f && f.alpha < 1 ? f.alpha : undefined }
    if (f || stroke) body.push(pathOp)
  }
  if (fill?.imageHref) {
    const img = loadImage(ctx, fill.imageHref)
    if (img?.ok) body.push({ t: 'image', x: box.x, y: box.y, w: box.w, h: box.h, image: img.data })
  }
  if (gp['marker-end'] || gp['marker-start']) {
    const d = rel(paths[0] ?? [])
    const pts: [number, number][] = []
    for (const s of d) if (s[0] === 'M' || s[0] === 'L') pts.push([s[1], s[2]])
    if (pts.length >= 2 && stroke) {
      if (gp['marker-end']) {
        const a = pts[pts.length - 2]
        const b = pts[pts.length - 1]
        body.push(...arrowHeadOps(b[0], b[1], Math.atan2(b[1] - a[1], b[0] - a[0]), stroke.width, 'triangle', 'med', stroke.color, 1))
      }
      if (gp['marker-start']) {
        const a = pts[0]
        const b = pts[1]
        body.push(...arrowHeadOps(a[0], a[1], Math.atan2(a[1] - b[1], a[0] - b[0]), stroke.width, 'triangle', 'med', stroke.color, 1))
      }
    }
  }
  // text inside the shape
  const hasText = n.children.some((c) => c.name === 'p' || c.name === 'list' || c.name === 'h')
  if (hasText) {
    const { tp, pb } = textBase(ctx, n)
    const inset = presetTextInset(prstForText)
    const area = { x: box.x + box.w * inset.l, y: box.y + box.h * inset.t, w: box.w * (1 - inset.l - inset.r), h: box.h * (1 - inset.t - inset.b) }
    body.push(...renderText(ctx, n, gp, area, tp, pb, gp['wrap-option'] === 'no-wrap'))
  }
  wrapRot(ops, box, body)
}

function renderFrame(ctx: Ctx, n: XNode, ops: Op[]): void {
  const cls = attr(n, 'class')
  if (ctx.inMaster && cls) {
    const shown = (cls === 'footer' && ctx.show.footer) || (cls === 'date-time' && ctx.show.dateTime) || (cls === 'page-number' && ctx.show.pageNumber)
    if (!shown) return // master placeholders are only prompts
  } else if (ctx.inMaster && PLACEHOLDER_CLASSES.has(cls ?? '')) return
  const box = shapeBox(n, ctx)
  const gp = shapeProps(ctx, n)
  const body: Op[] = []
  const tb = child(n, 'text-box')
  const img = child(n, 'image')
  const tbl = child(n, 'table')
  if (!box) {
    if (tb && textContent(tb).trim()) ctx.env.warnings.add(`A text frame on slide ${ctx.slideNo} has no position and was not drawn.`)
    return
  }
  const fill = fillOf(ctx, gp)
  const stroke = strokeOf(ctx, gp)
  if ((fill?.color || stroke) && !tbl) body.push({ t: 'rect', x: box.x, y: box.y, w: box.w, h: box.h, fill: fill?.color?.hex, stroke, opacity: fill?.color && fill.color.alpha < 1 ? fill.color.alpha : undefined })
  if (tb) {
    const { tp, pb } = textBase(ctx, n)
    body.push(...renderText(ctx, tb, gp, box, tp, pb, false))
  } else if (tbl) {
    // (Impress also stores a preview picture next to the table; the real table wins.)
    body.push(...renderTable(ctx, tbl, box))
  } else if (img) {
    const loaded = loadImage(ctx, attr(img, 'href'), img)
    const name = attr(n, 'name') ?? 'Picture'
    if (loaded?.ok) {
      const clip = parseClip(gp['clip'], box)
      body.push({ t: 'image', x: box.x, y: box.y, w: box.w, h: box.h, image: loaded.data, crop: clip })
    } else {
      ctx.env.warnings.add(`Slide ${ctx.slideNo}: “${name}” could not be drawn (${loaded ? loaded.fmt + ' pictures cannot be embedded' : 'the picture data is missing'}); a placeholder is shown.`)
      placeholderBox(ctx.env, body, box.x, box.y, box.w, box.h, loaded ? `Picture (${loaded.fmt.toUpperCase()})` : 'Picture')
    }
  } else {
    const obj = n.children.find((c) => ['object', 'object-ole', 'plugin', 'applet', 'floating-frame'].includes(c.name))
    if (obj) {
      let kind = 'Embedded object'
      const href = attr(obj, 'href')
      if (href) {
        const sub = ctx.pkg.xml(`${href.replace(/^\.\//, '')}/content.xml`)
        if (sub && descendants(sub, 'chart').length) kind = 'Chart'
      }
      ctx.env.warnings.add(`${kind} “${attr(n, 'name') ?? kind}” on slide ${ctx.slideNo} is not rendered; a labelled placeholder is shown.`)
      placeholderBox(ctx.env, body, box.x, box.y, box.w, box.h, kind)
    } else if (n.children.length) {
      ctx.env.warnings.add(`A frame on slide ${ctx.slideNo} has content Epdf cannot render (${n.children[0].name}).`)
    }
  }
  wrapRot(ops, box, body)
}

function parseClip(v: string | undefined, box: Box): { l: number; t: number; r: number; b: number } | undefined {
  const m = /rect\(([^)]*)\)/.exec(v ?? '')
  if (!m) return undefined
  const [t, r, b, l] = m[1].split(/[\s,]+/).filter(Boolean).map((x) => odfLength(x))
  if (![t, r, b, l].every(Number.isFinite) || (!t && !r && !b && !l)) return undefined
  const fw = box.w + l + r
  const fh = box.h + t + b
  return { l: l / fw, r: r / fw, t: t / fh, b: b / fh }
}

// ---------------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------------

interface ListCtx {
  style: XNode | undefined
  level: number
  counters: number[]
}

function levelStyle(list: XNode | undefined, level: number): XNode | undefined {
  return list?.children.find((c) => attr(c, 'level') === String(level))
}

function numText(fmt: string, n: number): string {
  const alpha = (k: number): string => {
    let s = ''
    let v = k
    while (v > 0) {
      s = String.fromCharCode(97 + ((v - 1) % 26)) + s
      v = Math.floor((v - 1) / 26)
    }
    return s
  }
  const roman = (k: number): string => {
    let s = ''
    let v = k
    for (const [val, sym] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']] as [number, string][]) while (v >= val) ((s += sym), (v -= val))
    return s
  }
  switch (fmt) {
    case 'a':
      return alpha(n)
    case 'A':
      return alpha(n).toUpperCase()
    case 'i':
      return roman(n)
    case 'I':
      return roman(n).toUpperCase()
    case '':
      return ''
    default:
      return String(n)
  }
}

function buildBlocks(ctx: Ctx, container: XNode, tp0: TextProps, pb0: ParaBase, out: Block[], list: ListCtx | undefined): void {
  for (const c of container.children) {
    if (c.name === 'p' || c.name === 'h') out.push(buildParagraph(ctx, c, tp0, pb0, list, out.length === 0))
    else if (c.name === 'list') {
      const sname = attr(c, 'style-name')
      const style = (sname ? ctx.st.listStyles.get(sname) : undefined) ?? list?.style ?? ctx.defaultList
      const level = (list?.level ?? 0) + 1
      let counters = list?.counters ?? []
      if (!list) {
        const key = sname ?? ''
        counters = attr(c, 'continue-numbering') === 'true' ? (ctx.counters.get(key) ?? []) : []
        ctx.counters.set(key, counters)
      }
      for (const li of c.children) {
        if (li.name !== 'list-item' && li.name !== 'list-header') continue
        buildBlocks(ctx, li, tp0, pb0, out, { style, level, counters })
      }
    }
  }
}

function buildParagraph(ctx: Ctx, p: XNode, tp0: TextProps, pb0: ParaBase, list: ListCtx | undefined, first: boolean): Block {
  const pstyle = ctx.st.resolve('paragraph', attr(p, 'style-name'))
  const tp = applyTextProps(tp0, pstyle.text, ctx.st.fonts)
  const pb = applyParaProps(pb0, pstyle.para)
  const inlines: Inline[] = []
  let lastSpace = true
  const walk = (n: XNode, cur: TextProps, link?: string): void => {
    for (const x of n.nodes) {
      if (typeof x === 'string') {
        let t = x.replace(/[ \t\r\n]+/g, ' ')
        if (lastSpace && t.startsWith(' ')) t = t.slice(1)
        if (!t) continue
        lastSpace = t.endsWith(' ')
        inlines.push({ k: 'text', text: t, style: styleOf(cur, link), link })
        continue
      }
      switch (x.name) {
        case 'span': {
          const sp = ctx.st.resolve('text', attr(x, 'style-name'))
          walk(x, applyTextProps(cur, sp.text, ctx.st.fonts), link)
          break
        }
        case 'a': {
          const href = attr(x, 'href')
          const safe = href && /^(https?:\/\/|mailto:)/i.test(href) ? href : undefined
          walk(x, safe ? { ...cur, underline: true, color: '#000080' } : cur, safe ?? link)
          break
        }
        case 's': {
          const cnt = parseInt(attr(x, 'c') ?? '1', 10) || 1
          inlines.push({ k: 'text', text: ' '.repeat(cnt), style: styleOf(cur, link) })
          lastSpace = true
          break
        }
        case 'tab':
          inlines.push({ k: 'tab', style: styleOf(cur, link) })
          lastSpace = true
          break
        case 'line-break':
          inlines.push({ k: 'br', type: 'line', style: styleOf(cur, link) })
          lastSpace = true
          break
        case 'page-number':
          inlines.push({ k: 'text', text: String(ctx.slideNo), style: styleOf(cur, link) })
          lastSpace = false
          break
        case 'page-count':
          inlines.push({ k: 'text', text: String(ctx.total), style: styleOf(cur, link) })
          lastSpace = false
          break
        case 'date':
        case 'time':
        case 'title':
        case 'file-name':
        case 'initial-creator':
        case 'creator':
        case 'subject':
        case 'description':
        case 'user-defined':
        case 'sequence':
        case 'chapter':
        case 'text-input':
        case 'placeholder':
        case 'variable-get':
        case 'expression':
        case 'bookmark-ref':
        case 'reference-ref': {
          const t = textContent(x)
          if (t) {
            inlines.push({ k: 'text', text: t, style: styleOf(cur, link) })
            lastSpace = t.endsWith(' ')
          }
          break
        }
        case 'annotation':
        case 'note':
        case 'bookmark':
        case 'bookmark-start':
        case 'bookmark-end':
        case 'soft-page-break':
        case 'index-mark':
          break
        default:
          if (x.name !== 'frame' && x.name !== 'custom-shape') walk(x, cur, link)
          break
      }
    }
  }
  const styleOf = (t: TextProps, l?: string): TextStyle => toTextStyle(l ? { ...t } : t, DEFAULT_FAMILY)
  walk(p, tp)
  const markStyle = toTextStyle(tp, DEFAULT_FAMILY)
  // list marker and indentation
  let marker: ParaProps['marker']
  let left = pb.marginLeft
  let firstLine = pb.indent
  if (list && list.style) {
    const ls = levelStyle(list.style, list.level)
    if (ls) {
      const props = child(ls, 'list-level-properties')
      const align = child(props, 'list-level-label-alignment')
      if (align) {
        left = odfLength(attr(align, 'margin-left'))
        firstLine = odfLength(attr(align, 'text-indent'))
      } else {
        const before = odfLength(attr(props, 'space-before'))
        const width = odfLength(attr(props, 'min-label-width'))
        left = before + width + pb.marginLeft
        firstLine = -width
      }
      const hasText = inlines.some((i) => i.k === 'text' && i.text.trim())
      let text = ''
      if (ls.name === 'list-level-style-bullet') text = attr(ls, 'bullet-char') ?? '•'
      else if (ls.name === 'list-level-style-number') {
        const startVal = parseInt(attr(ls, 'start-value') ?? '1', 10) || 1
        const c = list.counters
        c[list.level] = (c[list.level] ?? startVal - 1) + 1
        for (let l = list.level + 1; l < c.length; l++) c[l] = 0
        text = `${attr(ls, 'num-prefix') ?? ''}${numText(attr(ls, 'num-format') ?? '1', c[list.level])}${attr(ls, 'num-suffix') ?? ''}`
      } else if (ls.name === 'list-level-style-image') text = '•'
      if (list.level < list.counters.length && ls.name !== 'list-level-style-number') for (let l = list.level; l < list.counters.length; l++) list.counters[l] = 0
      if (text && hasText) {
        const lp = child(ls, 'text-properties')
        let mt = tp
        if (lp) mt = applyTextProps(mt, lp.attrs ? Object.fromEntries(Object.entries(lp.attrs).map(([k, v]) => [k.slice(k.indexOf(':') + 1), v])) : {}, ctx.st.fonts)
        if (mt.family && /opensymbol|symbol|wingdings/i.test(mt.family)) mt = { ...mt, family: tp.family }
        marker = { text, style: toTextStyle({ ...mt, bold: tp.bold && ls.name !== 'list-level-style-bullet', underline: false, strike: false }, DEFAULT_FAMILY) }
      }
    }
  }
  if (marker && firstLine >= 0) {
    left += firstLine + 14
    firstLine = -14
  }
  const props: ParaProps = {
    ...DEFAULT_PARA_PROPS,
    align: pb.align,
    spaceBefore: first ? 0 : pb.before,
    spaceAfter: pb.after,
    line: pb.line,
    indentLeft: left,
    indentRight: pb.marginRight,
    firstLine,
    widowControl: false,
    marker
  }
  return { k: 'p', props, inlines, markStyle }
}

function renderText(ctx: Ctx, textNode: XNode, gp: Record<string, string>, area: { x: number; y: number; w: number; h: number }, tp: TextProps, pb: ParaBase, noWrap: boolean): Op[] {
  const padL = odfLength(gp['padding-left'], 0.25 * PT_PER_CM)
  const padR = odfLength(gp['padding-right'], 0.25 * PT_PER_CM)
  const padT = odfLength(gp['padding-top'], 0.125 * PT_PER_CM)
  const padB = odfLength(gp['padding-bottom'], 0.125 * PT_PER_CM)
  const innerW = Math.max(1, area.w - padL - padR)
  const innerH = Math.max(1, area.h - padT - padB)
  const shrink = gp['shrink-to-fit'] === 'true'
  const build = (scale: number): Block[] => {
    const blocks: Block[] = []
    buildBlocks(ctx, textNode, scaleText(tp, scale), pb, blocks, undefined)
    return blocks
  }
  const hasContent = (b: Block[]): boolean => b.some((x) => x.k === 'p' && x.inlines.length > 0)
  const layout = (scale: number): { lay: ReturnType<typeof layoutTextBlock>; width: number } => {
    const blocks = build(scale)
    if (noWrap) {
      const probe = layoutTextBlock(ctx.env, blocks, 100000)
      const width = Math.max(innerW, probe.extent + 1)
      return { lay: layoutTextBlock(ctx.env, blocks, width), width }
    }
    return { lay: layoutTextBlock(ctx.env, blocks, innerW), width: innerW }
  }
  if (!hasContent(build(1))) return []
  let scale = 1
  let res = layout(1)
  if (shrink && res.lay.height > innerH) {
    for (const s of [0.9, 0.8, 0.7, 0.6, 0.5]) {
      scale = s
      res = layout(s)
      if (res.lay.height <= innerH) break
    }
  }
  const va = gp['textarea-vertical-align']
  const dy = va === 'middle' ? (innerH - res.lay.height) / 2 : va === 'bottom' ? innerH - res.lay.height : 0
  let dx = 0
  if (noWrap) {
    const first = build(scale).find((b) => b.k === 'p')
    const al = first && first.k === 'p' ? first.props.align : 'left'
    dx = al === 'center' ? (innerW - res.width) / 2 : al === 'right' ? innerW - res.width : 0
  }
  return shiftOps(res.lay.ops, area.x + padL + dx, area.y + padT + dy)
}

const scaleText = (t: TextProps, s: number): TextProps => (s === 1 ? t : { ...t, size: t.size * s })

// ---------------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------------

function renderTable(ctx: Ctx, tbl: XNode, box: Box): Op[] {
  const cols: number[] = []
  const rowsNodes: XNode[] = []
  const collect = (n: XNode): void => {
    for (const c of n.children) {
      if (c.name === 'table-column') {
        const w = odfLength(ctx.st.resolve('table-column', attr(c, 'style-name')).col['column-width'], 60)
        const rep = Math.min(200, parseInt(attr(c, 'number-columns-repeated') ?? '1', 10) || 1)
        for (let i = 0; i < rep; i++) cols.push(w)
      } else if (c.name === 'table-columns' || c.name === 'table-header-columns') collect(c)
      else if (c.name === 'table-row') {
        const rep = Math.min(500, parseInt(attr(c, 'number-rows-repeated') ?? '1', 10) || 1)
        for (let i = 0; i < rep; i++) rowsNodes.push(c)
      } else if (c.name === 'table-rows' || c.name === 'table-header-rows') collect(c)
    }
  }
  collect(tbl)
  if (cols.length === 0) return []
  const { tp, pb } = { tp: baseTextProps(), pb: baseParaProps() }
  const tcBase = applyTextProps(tp, ctx.st.resolve('graphic', undefined).text, ctx.st.fonts)
  const rows: Row[] = rowsNodes.map((r) => {
    const cells: Cell[] = []
    const rh = odfLength(ctx.st.resolve('table-row', attr(r, 'style-name')).row['min-row-height'] ?? ctx.st.resolve('table-row', attr(r, 'style-name')).row['row-height'], 0)
    for (const c of r.children) {
      if (c.name !== 'table-cell') continue
      const rep = Math.min(50, parseInt(attr(c, 'number-columns-repeated') ?? '1', 10) || 1)
      const span = parseInt(attr(c, 'number-columns-spanned') ?? '1', 10) || 1
      const rspan = parseInt(attr(c, 'number-rows-spanned') ?? '1', 10) || 1
      const rs = ctx.st.resolve('table-cell', attr(c, 'style-name') ?? attr(r, 'default-cell-style-name'))
      // (some Impress versions write the cell borders into style:paragraph-properties)
      const cp: Record<string, string> = { ...Object.fromEntries(Object.entries(rs.para).filter(([k]) => k.startsWith('border'))), ...rs.cell }
      for (let k = 0; k < rep; k++) {
        const blocks: Block[] = []
        buildBlocks(ctx, c, tcBase, pb, blocks, undefined)
        if (blocks.length === 0) blocks.push({ k: 'p', props: { ...DEFAULT_PARA_PROPS }, inlines: [], markStyle: toTextStyle(tcBase, DEFAULT_FAMILY) })
        const bg = cp['background-color']
        const pad = odfLength(cp['padding'], 0.1 * PT_PER_CM)
        const borders: NonNullable<Cell['borders']> = {}
        for (const side of ['left', 'right', 'top', 'bottom'] as const) {
          const b = odfBorder(cp[`border-${side}`] ?? cp['border'])
          if (b !== undefined) borders[side] = b
        }
        const va = cp['vertical-align']
        cells.push({
          blocks,
          colSpan: span,
          rowSpan: rspan,
          shading: bg && /^#[0-9a-f]{6}$/i.test(bg) ? bg.toLowerCase() : undefined,
          borders,
          padding: { top: odfLength(cp['padding-top'], pad), bottom: odfLength(cp['padding-bottom'], pad), left: odfLength(cp['padding-left'], pad), right: odfLength(cp['padding-right'], pad) },
          vAlign: va === 'middle' ? 'center' : va === 'bottom' ? 'bottom' : 'top'
        })
      }
    }
    return { cells, height: { value: rh, rule: 'atLeast' }, header: false, cantSplit: true }
  })
  const table: Table = { k: 'table', colWidths: cols, rows, borders: {}, padding: { top: 2.8, right: 2.8, bottom: 2.8, left: 2.8 }, align: 'left', indent: 0 }
  const frags = tableFragments({ catalog: ctx.env.catalog, warnings: ctx.env.warnings, defaultTabStop: 72, maxBlockHeight: 100000 }, table, cols.reduce((s, w) => s + w, 0) + 1)
  return shiftOps(stackFragments(frags).ops, box.x, box.y)
}
