import {
  DEFAULT_CLR_MAP,
  EMU_PER_PT,
  applyPPr,
  applyRPr,
  autoNumText,
  bulletText,
  dashArray,
  findColor,
  newPPr,
  parseTheme,
  readFill,
  readLine,
  type ClrMap,
  type ColorCtx,
  type FillSpec,
  type LineSpec,
  type PPr,
  type RPr,
  type Rgba,
  type ThemeInfo
} from './drawingml'
import { OfficeError, throwIfCancelled, type ConvertEnv } from './env'
import type { BorderSpec, Block, Cell, Inline, ParaProps, Paragraph, Row, Table, TextStyle } from './flow'
import { DEFAULT_PARA_PROPS } from './flow'
import { tableFragments, shiftOps, stackFragments } from './layout'
import type { Op, Page, PathSeg, Stroke } from './ops'
import { imageFormat, openPackage, relationshipsOf, type Pkg, type Relationship } from './package'
import { arrowHeadOps, layoutTextBlock, mapPath, placeholderBox as placeholderBoxShared, presetPath, presetTextInset, rectPath } from './slideShapes'
import { attr, child, childrenNamed, numAttr, path as xpath, type XNode } from './xml'

/**
 * PPTX -> PDF pages. One page per slide, sized like the slide. Shapes are drawn as vector paths, text boxes
 * are laid out with the shared paragraph engine (bundled metric-compatible fonts), pictures are embedded, and
 * placeholders inherit geometry, text styles and body properties from their layout and master.
 */

interface Tree {
  part: string
  rels: Map<string, Relationship>
  root: XNode
  spTree: XNode | undefined
}

/** Affine mapping from a coordinate space in EMU to slide points: pt = a * emu + b. */
interface Xf {
  ax: number
  bx: number
  ay: number
  by: number
}

interface Ctx {
  env: ConvertEnv
  pkg: Pkg
  cc: ColorCtx
  presDefault: XNode | undefined
  tableStyles: XNode | undefined
  slideNo: number
  slideW: number
  slideH: number
  slide: Tree
  layout?: Tree
  master?: Tree
  flags: { effects: boolean; gradient: boolean }
  /** Tree whose rels resolve r:ids of the shape currently being drawn. */
  cur: Tree
}

const relId = (n: XNode | undefined): string | undefined => {
  if (!n) return undefined
  for (const k of Object.keys(n.attrs)) if (k === 'r:id' || k.endsWith(':id')) return n.attrs[k]
  return undefined
}

const isTrue = (v: string | undefined): boolean => v === '1' || v === 'true'

export async function convertPptx(bytes: Uint8Array, env: ConvertEnv): Promise<Page[]> {
  const pkg = openPackage(bytes, 'presentation')
  let presPart = 'ppt/presentation.xml'
  for (const r of relationshipsOf(pkg, '').values()) if (r.type === 'officeDocument') presPart = r.target
  const presRoot = pkg.xml(presPart)
  const pres = presRoot?.children.find((c) => c.name === 'presentation')
  if (!pres) throw new OfficeError('This PowerPoint file does not contain a presentation (ppt/presentation.xml is missing).')
  const presRels = relationshipsOf(pkg, presPart)
  const sz = child(pres, 'sldSz')
  const slideW = (numAttr(sz, 'cx') ?? 9144000) / EMU_PER_PT
  const slideH = (numAttr(sz, 'cy') ?? 6858000) / EMU_PER_PT
  const presDefault = child(pres, 'defaultTextStyle')
  let tableStyles: XNode | undefined
  for (const r of presRels.values()) if (r.type === 'tableStyles') tableStyles = pkg.xml(r.target)?.children.find((c) => c.name === 'tblStyleLst')

  const slideIds = childrenNamed(child(pres, 'sldIdLst'), 'sldId')
  if (slideIds.length === 0) throw new OfficeError('This presentation has no slides.')
  const pages: Page[] = []
  const themeCache = new Map<string, ThemeInfo>()
  const flags = { effects: false, gradient: false }

  for (let i = 0; i < slideIds.length; i++) {
    throwIfCancelled(env)
    env.progress(i / slideIds.length, `Slide ${i + 1} of ${slideIds.length}`)
    const rel = presRels.get(relId(slideIds[i]) ?? '')
    if (!rel) {
      env.warnings.add(`Slide ${i + 1} is listed in the presentation but its content is missing; a blank page was written.`)
      pages.push({ width: slideW, height: slideH, ops: [] })
      continue
    }
    const sRoot = pkg.xml(rel.target)?.children.find((c) => c.name === 'sld')
    if (!sRoot) {
      env.warnings.add(`Slide ${i + 1} could not be read; a blank page was written.`)
      pages.push({ width: slideW, height: slideH, ops: [] })
      continue
    }
    if (attr(sRoot, 'show') === '0') {
      env.warnings.add(`Hidden slide ${i + 1} was skipped.`)
      continue
    }
    const slide = mkTree(pkg, rel.target, sRoot, 'cSld')
    let layout: Tree | undefined
    let master: Tree | undefined
    for (const r of slide.rels.values()) {
      if (r.type === 'slideLayout') {
        const lr = pkg.xml(r.target)?.children.find((c) => c.name === 'sldLayout')
        if (lr) layout = mkTree(pkg, r.target, lr, 'cSld')
      }
    }
    if (layout) {
      for (const r of layout.rels.values()) {
        if (r.type === 'slideMaster') {
          const mr = pkg.xml(r.target)?.children.find((c) => c.name === 'sldMaster')
          if (mr) master = mkTree(pkg, r.target, mr, 'cSld')
        }
      }
    }
    let theme: ThemeInfo | undefined
    if (master) {
      for (const r of master.rels.values()) {
        if (r.type === 'theme') {
          theme = themeCache.get(r.target)
          if (!theme) {
            theme = parseTheme(pkg.xml(r.target))
            themeCache.set(r.target, theme)
          }
        }
      }
    }
    theme ??= parseTheme(undefined)
    let clrMap: ClrMap = { ...DEFAULT_CLR_MAP }
    const mm = child(master?.root, 'clrMap')
    if (mm) clrMap = { ...clrMap, ...mm.attrs }
    for (const t of [layout?.root, slide.root]) {
      const ov = child(child(t, 'clrMapOvr'), 'overrideClrMapping')
      if (ov) clrMap = { ...clrMap, ...ov.attrs }
    }
    const ctx: Ctx = { env, pkg, cc: { theme, clrMap }, presDefault, tableStyles, slideNo: i + 1, slideW, slideH, slide, layout, master, flags, cur: slide }
    pages.push(renderSlide(ctx))
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0))
  }
  if (flags.effects) env.warnings.add('Shadows, glow, reflections and 3-D effects are not rendered.')
  if (flags.gradient) env.warnings.add('Gradient fills are approximated by a single solid colour.')
  if (pages.length === 0) throw new OfficeError('Every slide in this presentation is hidden, so there is nothing to convert.')
  return pages
}

function mkTree(pkg: Pkg, part: string, root: XNode, _cs: string): Tree {
  return { part, rels: relationshipsOf(pkg, part), root, spTree: xpath(root, 'cSld', 'spTree') }
}

// ---------------------------------------------------------------------------------------------------
// Slide
// ---------------------------------------------------------------------------------------------------

function renderSlide(ctx: Ctx): Page {
  const page: Page = { width: ctx.slideW, height: ctx.slideH, ops: [] }
  const ops = page.ops
  // background: slide, else layout, else master
  for (const t of [ctx.slide, ctx.layout, ctx.master]) {
    if (!t) continue
    const bg = xpath(t.root, 'cSld', 'bg')
    if (!bg) continue
    ctx.cur = t
    const fill = backgroundFill(ctx, bg)
    if (fill) {
      applyBackground(ctx, page, fill)
      break
    }
  }
  const hideAll = attr(ctx.slide.root, 'showMasterSp') === '0'
  const hideMaster = attr(ctx.layout?.root, 'showMasterSp') === '0'
  const root: Xf = { ax: 1 / EMU_PER_PT, bx: 0, ay: 1 / EMU_PER_PT, by: 0 }
  if (ctx.master && !hideAll && !hideMaster) {
    ctx.cur = ctx.master
    renderTree(ctx, ctx.master, root, ops, false)
  }
  if (ctx.layout && !hideAll) {
    ctx.cur = ctx.layout
    renderTree(ctx, ctx.layout, root, ops, false)
  }
  ctx.cur = ctx.slide
  renderTree(ctx, ctx.slide, root, ops, true)
  return page
}

function backgroundFill(ctx: Ctx, bg: XNode): FillSpec | undefined {
  const pr = child(bg, 'bgPr')
  if (pr) return readFill(pr, ctx.cc)
  const ref = child(bg, 'bgRef')
  if (ref) {
    const idx = numAttr(ref, 'idx') ?? 0
    const col = findColor(ref, ctx.cc.theme, ctx.cc.clrMap)
    if (idx >= 1001) {
      const node = ctx.cc.theme.bgFillStyles[idx - 1001]
      if (node) return readFill({ children: [node] } as unknown as XNode, ctx.cc, col ?? undefined)
    }
    if (col) return { kind: 'solid', color: col }
  }
  return undefined
}

function applyBackground(ctx: Ctx, page: Page, f: FillSpec): void {
  if (f.kind === 'solid' || f.kind === 'grad') {
    page.background = f.color.hex
    if (f.kind === 'grad') ctx.flags.gradient = true
  } else if (f.kind === 'blip') {
    const img = loadImage(ctx, f.rid)
    if (img && img.ok) page.ops.push({ t: 'image', x: 0, y: 0, w: page.width, h: page.height, image: img.data, crop: f.crop })
    else ctx.env.warnings.add(`The background picture of slide ${ctx.slideNo} could not be used${img ? ` (${img.fmt} pictures are not supported)` : ''}.`)
  }
}

/** Draws the shapes of a tree. Placeholders are only drawn for the slide itself. */
function renderTree(ctx: Ctx, tree: Tree, xf: Xf, ops: Op[], drawPlaceholders: boolean): void {
  if (!tree.spTree) return
  renderChildren(ctx, tree, tree.spTree, xf, ops, drawPlaceholders)
}

function renderChildren(ctx: Ctx, tree: Tree, parent: XNode, xf: Xf, ops: Op[], drawPh: boolean): void {
  for (const n of parent.children) {
    throwIfCancelled(ctx.env)
    renderNode(ctx, tree, n, xf, ops, drawPh)
  }
}

function renderNode(ctx: Ctx, tree: Tree, n: XNode, xf: Xf, ops: Op[], drawPh: boolean): void {
  switch (n.name) {
    case 'sp':
      renderSp(ctx, tree, n, xf, ops, drawPh)
      break
    case 'cxnSp':
      renderConnector(ctx, tree, n, xf, ops)
      break
    case 'pic':
      renderPic(ctx, tree, n, xf, ops, drawPh)
      break
    case 'grpSp':
      renderGroup(ctx, tree, n, xf, ops, drawPh)
      break
    case 'graphicFrame':
      renderFrame(ctx, tree, n, xf, ops)
      break
    case 'AlternateContent': {
      const pick = child(n, 'Fallback') ?? child(n, 'Choice')
      if (pick) for (const c of pick.children) renderNode(ctx, tree, c, xf, ops, drawPh)
      break
    }
    case 'contentPart':
      ctx.env.warnings.add(`Ink or embedded content on slide ${ctx.slideNo} is not rendered.`)
      break
    default:
      break
  }
}

// ---------------------------------------------------------------------------------------------------
// Placeholders and inheritance
// ---------------------------------------------------------------------------------------------------

interface PhInfo {
  type: string
  idx: string | undefined
}

const nvPrOf = (sp: XNode): XNode | undefined => {
  for (const k of ['nvSpPr', 'nvPicPr', 'nvGraphicFramePr', 'nvCxnSpPr', 'nvGrpSpPr']) {
    const nv = child(sp, k)
    if (nv) return child(nv, 'nvPr')
  }
  return undefined
}
const cNvPrOf = (sp: XNode): XNode | undefined => {
  for (const k of ['nvSpPr', 'nvPicPr', 'nvGraphicFramePr', 'nvCxnSpPr', 'nvGrpSpPr']) {
    const nv = child(sp, k)
    if (nv) return child(nv, 'cNvPr')
  }
  return undefined
}

function phOf(sp: XNode): PhInfo | undefined {
  const ph = child(nvPrOf(sp), 'ph')
  if (!ph) return undefined
  return { type: attr(ph, 'type') ?? 'obj', idx: attr(ph, 'idx') }
}

const phClass = (type: string): string => (type === 'title' || type === 'ctrTitle' ? 'title' : type === 'dt' || type === 'ftr' || type === 'sldNum' ? type : 'body')

function findPh(tree: Tree | undefined, ph: PhInfo, byClassOnly: boolean): XNode | undefined {
  if (!tree?.spTree) return undefined
  const all = tree.spTree.children.filter((c) => (c.name === 'sp' || c.name === 'pic') && phOf(c))
  if (!byClassOnly && ph.idx !== undefined) {
    const byIdx = all.find((c) => phOf(c)!.idx === ph.idx)
    if (byIdx) return byIdx
  }
  const cls = phClass(ph.type)
  const sameType = all.find((c) => phOf(c)!.type === ph.type)
  if (sameType && !byClassOnly) return sameType
  return all.find((c) => phClass(phOf(c)!.type) === cls)
}

interface Chain {
  /** The shape itself first, then its layout placeholder, then its master placeholder (when present). */
  nodes: XNode[]
  ph?: PhInfo
  /** Layout/master placeholder shapes (lowest priority last). */
  master?: XNode
  layout?: XNode
}

function chainFor(ctx: Ctx, tree: Tree, sp: XNode): Chain {
  const ph = phOf(sp)
  const nodes = [sp]
  if (!ph || tree !== ctx.slide) return { nodes, ph }
  const lay = findPh(ctx.layout, ph, false)
  const mas = findPh(ctx.master, lay ? (phOf(lay) ?? ph) : ph, !lay)
  if (lay) nodes.push(lay)
  if (mas) nodes.push(mas)
  return { nodes, ph, layout: lay, master: mas }
}

const spPrOf = (sp: XNode): XNode | undefined => child(sp, 'spPr')

function xfrmOf(chain: Chain): XNode | undefined {
  for (const n of chain.nodes) {
    const x = child(spPrOf(n), 'xfrm') ?? child(n, 'xfrm')
    if (x && child(x, 'ext')) return x
  }
  return undefined
}

interface Box {
  x: number
  y: number
  w: number
  h: number
  rot: number
  flipH: boolean
  flipV: boolean
}

function boxFrom(x: XNode | undefined, xf: Xf): Box | undefined {
  if (!x) return undefined
  const off = child(x, 'off')
  const ext = child(x, 'ext')
  if (!ext) return undefined
  const ex = numAttr(off, 'x') ?? 0
  const ey = numAttr(off, 'y') ?? 0
  const cx = numAttr(ext, 'cx') ?? 0
  const cy = numAttr(ext, 'cy') ?? 0
  return {
    x: xf.ax * ex + xf.bx,
    y: xf.ay * ey + xf.by,
    w: xf.ax * cx,
    h: xf.ay * cy,
    rot: (numAttr(x, 'rot') ?? 0) / 60000,
    flipH: isTrue(attr(x, 'flipH')),
    flipV: isTrue(attr(x, 'flipV'))
  }
}

// ---------------------------------------------------------------------------------------------------
// Fill / line resolution
// ---------------------------------------------------------------------------------------------------

function styleColor(ctx: Ctx, sp: XNode, refName: string): { idx: number; color: Rgba | null } | undefined {
  const ref = child(child(sp, 'style'), refName)
  if (!ref) return undefined
  return { idx: numAttr(ref, 'idx') ?? 0, color: findColor(ref, ctx.cc.theme, ctx.cc.clrMap) }
}

function resolveFill(ctx: Ctx, chain: Chain): FillSpec | undefined {
  for (const n of chain.nodes) {
    const f = readFill(spPrOf(n), ctx.cc)
    if (f) return f
  }
  const st = styleColor(ctx, chain.nodes[0], 'fillRef')
  if (st && st.idx > 0) {
    const node = ctx.cc.theme.fillStyles[Math.min(st.idx, ctx.cc.theme.fillStyles.length) - 1]
    if (node) return readFill({ children: [node] } as unknown as XNode, ctx.cc, st.color ?? undefined)
    if (st.color) return { kind: 'solid', color: st.color }
  }
  return undefined
}

function resolveLine(ctx: Ctx, chain: Chain): LineSpec {
  const layers: LineSpec[] = []
  const st = styleColor(ctx, chain.nodes[0], 'lnRef')
  if (st && st.idx > 0) {
    const node = ctx.cc.theme.lnStyles[Math.min(st.idx, ctx.cc.theme.lnStyles.length) - 1]
    const l = node ? readLine(node, ctx.cc, st.color ?? undefined) : undefined
    layers.push(l ?? { none: false, width: 0.75, color: st.color ?? undefined })
    if (l && !l.color && st.color) l.color = st.color
  }
  for (let i = chain.nodes.length - 1; i >= 0; i--) {
    const ln = child(spPrOf(chain.nodes[i]), 'ln')
    const l = readLine(ln, ctx.cc)
    if (l) layers.push(l)
  }
  const out: LineSpec = { none: layers.length === 0 }
  for (const l of layers) {
    if (l.none) out.none = true
    else if (l.width !== undefined || l.color || l.dash || l.head || l.tail) out.none = false
    if (l.width !== undefined) out.width = l.width
    if (l.color) out.color = l.color
    if (l.dash) out.dash = l.dash
    if (l.head) {
      out.head = l.head
      out.headSize = l.headSize
    }
    if (l.tail) {
      out.tail = l.tail
      out.tailSize = l.tailSize
    }
  }
  return out
}

function strokeOf(line: LineSpec, ctx: Ctx, fallbackColor = '#000000'): Stroke | undefined {
  if (line.none) return undefined
  const width = line.width ?? 0.75
  if (width <= 0 && !line.color) return undefined
  void ctx
  return { color: line.color?.hex ?? fallbackColor, width: Math.max(width, 0.25), dash: dashArray(line.dash, width) }
}

function noteEffects(ctx: Ctx, chain: Chain): void {
  for (const n of chain.nodes) {
    const sp = spPrOf(n)
    const eff = child(sp, 'effectLst')
    if (eff && eff.children.length > 0) ctx.flags.effects = true
    if (child(sp, 'scene3d') || child(sp, 'sp3d')) ctx.flags.effects = true
  }
  const er = styleColor(ctx, chain.nodes[0], 'effectRef')
  if (er && er.idx > 0) {
    const es = ctx.cc.theme.effectStyles[Math.min(er.idx, ctx.cc.theme.effectStyles.length) - 1]
    const lst = child(es, 'effectLst')
    if (lst && lst.children.some((c) => /Shdw|glow|reflection|softEdge/i.test(c.name))) ctx.flags.effects = true
  }
}

// ---------------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------------

function rotateWrap(ops: Op[], box: Box, body: Op[]): void {
  if (Math.abs(box.rot) > 0.01) {
    ops.push({ t: 'push', rotate: { deg: box.rot, cx: box.x + box.w / 2, cy: box.y + box.h / 2 } }, ...body, { t: 'pop' })
  } else ops.push(...body)
}

interface Geometry {
  prst: string
  adj: Record<string, number>
  cust?: XNode
}

function geometryOf(chain: Chain): Geometry {
  for (const n of chain.nodes) {
    const sp = spPrOf(n)
    const pg = child(sp, 'prstGeom')
    if (pg) {
      const adj: Record<string, number> = {}
      for (const gd of childrenNamed(child(pg, 'avLst'), 'gd')) {
        const m = /val\s+(-?\d+)/.exec(attr(gd, 'fmla') ?? '')
        if (m && attr(gd, 'name')) adj[attr(gd, 'name')!] = parseInt(m[1], 10)
      }
      return { prst: attr(pg, 'prst') ?? 'rect', adj }
    }
    const cg = child(sp, 'custGeom')
    if (cg) return { prst: 'custom', adj: {}, cust: cg }
  }
  return { prst: 'rect', adj: {} }
}

const LINE_PRESETS = new Set(['line', 'straightConnector1', 'lineInv', 'bentConnector2', 'bentConnector3', 'bentConnector4', 'bentConnector5', 'curvedConnector2', 'curvedConnector3', 'curvedConnector4', 'curvedConnector5'])

function customPaths(ctx: Ctx, cust: XNode, box: Box): { d: PathSeg[]; fill: boolean; stroke: boolean }[] {
  const out: { d: PathSeg[]; fill: boolean; stroke: boolean }[] = []
  for (const p of childrenNamed(child(cust, 'pathLst'), 'path')) {
    const pw = numAttr(p, 'w') || box.w * EMU_PER_PT || 1
    const ph = numAttr(p, 'h') || box.h * EMU_PER_PT || 1
    const sx = box.w / pw
    const sy = box.h / ph
    const pt = (n: XNode | undefined): [number, number] => [(numAttr(n, 'x') ?? 0) * sx, (numAttr(n, 'y') ?? 0) * sy]
    const d: PathSeg[] = []
    let cur: [number, number] = [0, 0]
    for (const c of p.children) {
      if (c.name === 'moveTo') {
        cur = pt(child(c, 'pt'))
        d.push(['M', cur[0], cur[1]])
      } else if (c.name === 'lnTo') {
        cur = pt(child(c, 'pt'))
        d.push(['L', cur[0], cur[1]])
      } else if (c.name === 'cubicBezTo') {
        const pts = childrenNamed(c, 'pt').map((x) => pt(x))
        if (pts.length === 3) {
          d.push(['C', pts[0][0], pts[0][1], pts[1][0], pts[1][1], pts[2][0], pts[2][1]])
          cur = pts[2]
        }
      } else if (c.name === 'quadBezTo') {
        const pts = childrenNamed(c, 'pt').map((x) => pt(x))
        if (pts.length === 2) {
          const [q, e] = pts
          d.push(['C', cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1]), e[0] + (2 / 3) * (q[0] - e[0]), e[1] + (2 / 3) * (q[1] - e[1]), e[0], e[1]])
          cur = e
        }
      } else if (c.name === 'arcTo') {
        const wR = (numAttr(c, 'wR') ?? 0) * sx
        const hR = (numAttr(c, 'hR') ?? 0) * sy
        const st = ((numAttr(c, 'stAng') ?? 0) / 60000) * (Math.PI / 180)
        const sw = ((numAttr(c, 'swAng') ?? 0) / 60000) * (Math.PI / 180)
        if (wR > 0 && hR > 0) {
          const param = (a: number): number => Math.atan2(wR * Math.sin(a), hR * Math.cos(a))
          const t0 = param(st)
          let t1 = param(st + sw)
          while (sw > 0 && t1 < t0) t1 += 2 * Math.PI
          while (sw < 0 && t1 > t0) t1 -= 2 * Math.PI
          if (Math.abs(sw) >= 2 * Math.PI - 1e-6) t1 = t0 + Math.sign(sw) * 2 * Math.PI
          const cx = cur[0] - wR * Math.cos(t0)
          const cy = cur[1] - hR * Math.sin(t0)
          const n = Math.max(1, Math.ceil(Math.abs(t1 - t0) / (Math.PI / 2)))
          const step = (t1 - t0) / n
          const k = (4 / 3) * Math.tan(step / 4)
          let a = t0
          for (let i = 0; i < n; i++) {
            const ca = Math.cos(a)
            const sa = Math.sin(a)
            const cb = Math.cos(a + step)
            const sb = Math.sin(a + step)
            d.push(['C', cx + wR * (ca - k * sa), cy + hR * (sa + k * ca), cx + wR * (cb + k * sb), cy + hR * (sb - k * cb), cx + wR * cb, cy + hR * sb])
            a += step
          }
          cur = [cx + wR * Math.cos(t0 + n * step), cy + hR * Math.sin(t0 + n * step)]
        }
      } else if (c.name === 'close') d.push(['Z'])
    }
    if (d.length) out.push({ d, fill: attr(p, 'fill') !== 'none', stroke: !(attr(p, 'stroke') === '0' || attr(p, 'stroke') === 'false') })
  }
  void ctx
  return out
}

function renderSp(ctx: Ctx, tree: Tree, sp: XNode, xf: Xf, ops: Op[], drawPh: boolean): void {
  const cnv = cNvPrOf(sp)
  if (isTrue(attr(cnv, 'hidden'))) return
  const chain = chainFor(ctx, tree, sp)
  if (chain.ph && !drawPh) return
  const box = boxFrom(xfrmOf(chain), xf)
  const txBody = child(sp, 'txBody')
  if (!box) {
    if (txBody && txBody.children.some((p) => p.name === 'p' && p.children.some((r) => r.name === 'r' || r.name === 'fld'))) {
      ctx.env.warnings.add(`A text shape on slide ${ctx.slideNo} has no position and was not drawn.`)
    }
    return
  }
  const geom = geometryOf(chain)
  noteEffects(ctx, chain)
  const body: Op[] = []
  if (LINE_PRESETS.has(geom.prst)) {
    const line = resolveLine(ctx, chain)
    drawLine(ctx, body, box, geom, line)
    rotateWrap(ops, { ...box, rot: 0 }, body)
    return
  }
  const fill = resolveFill(ctx, chain)
  const line = resolveLine(ctx, chain)
  const isTextBox = isTrue(attr(child(sp, 'nvSpPr') ? child(child(sp, 'nvSpPr'), 'cNvSpPr') : undefined, 'txBox'))
  const effFill: FillSpec | undefined = fill ?? undefined
  if (effFill && effFill.kind === 'grad') ctx.flags.gradient = true
  const stroke = strokeOf(line, ctx)
  // geometry
  let paths: { d: PathSeg[]; fill: boolean; stroke: boolean }[] = []
  if (geom.cust) paths = customPaths(ctx, geom.cust, box)
  else {
    const pp = presetPath(geom.prst, box.w, box.h, geom.adj)
    if (pp) paths = [{ d: pp, fill: true, stroke: true }]
    else {
      paths = [{ d: rectPath(box.w, box.h), fill: true, stroke: true }]
      ctx.env.warnings.add(`The shape type “${geom.prst}” on slide ${ctx.slideNo} is not supported and is drawn as a rectangle.`)
      if (!stroke && (!effFill || effFill.kind === 'none')) paths[0].stroke = true
    }
  }
  const flipX = (x: number): number => (box.flipH ? box.w - x : x)
  const flipY = (y: number): number => (box.flipV ? box.h - y : y)
  const fillHex = effFill && (effFill.kind === 'solid' || effFill.kind === 'grad') ? effFill.color : undefined
  const unsupportedOutline = !presetPath(geom.prst, box.w, box.h, geom.adj) && !geom.cust
  for (const p of paths) {
    const d = mapPath(p.d, (x) => flipX(x) + box.x, (y) => flipY(y) + box.y)
    const st = p.stroke ? (stroke ?? (unsupportedOutline ? { color: '#808080', width: 0.75, dash: [3, 2] } : undefined)) : undefined
    const f = p.fill ? fillHex : undefined
    if (f || st) body.push({ t: 'path', d, fill: f?.hex, stroke: st, opacity: f && f.alpha < 1 ? f.alpha : undefined })
  }
  if (effFill && effFill.kind === 'blip') {
    const img = loadImage(ctx, effFill.rid)
    if (img?.ok) body.push({ t: 'image', x: box.x, y: box.y, w: box.w, h: box.h, image: img.data, crop: effFill.crop })
  }
  // arrows on open custom paths are not drawn; text follows
  if (txBody) {
    const inset = presetTextInset(geom.prst)
    const tb = { x: box.x + box.w * inset.l, y: box.y + box.h * inset.t, w: box.w * (1 - inset.l - inset.r), h: box.h * (1 - inset.t - inset.b) }
    const fontRef = styleColor(ctx, chain.nodes[0], 'fontRef')
    body.push(...renderTextBody(ctx, tree, chain, txBody, tb, fontRef?.color ?? undefined, isTextBox))
  }
  rotateWrap(ops, box, body)
}

function drawLine(ctx: Ctx, out: Op[], box: Box, geom: Geometry, line: LineSpec): void {
  const stroke = strokeOf(line, ctx) ?? (line.none ? undefined : { color: '#000000', width: 0.75 })
  if (!stroke) return
  const sx = box.flipH ? box.x + box.w : box.x
  const ex = box.flipH ? box.x : box.x + box.w
  const sy = box.flipV ? box.y + box.h : box.y
  const ey = box.flipV ? box.y : box.y + box.h
  const adj = (n: string, def: number): number => (geom.adj[n] ?? def) / 100000
  let d: PathSeg[]
  const prst = geom.prst
  if (prst === 'bentConnector2') d = [['M', sx, sy], ['L', ex, sy], ['L', ex, ey]]
  else if (prst === 'bentConnector3') {
    const mx = sx + (ex - sx) * adj('adj1', 50000)
    d = [['M', sx, sy], ['L', mx, sy], ['L', mx, ey], ['L', ex, ey]]
  } else if (prst === 'bentConnector4') {
    const x1 = sx + (ex - sx) * adj('adj1', 50000)
    const y2 = sy + (ey - sy) * adj('adj2', 50000)
    d = [['M', sx, sy], ['L', x1, sy], ['L', x1, y2], ['L', ex, y2], ['L', ex, ey]]
  } else if (prst === 'bentConnector5') {
    const x1 = sx + (ex - sx) * adj('adj1', 50000)
    const y2 = sy + (ey - sy) * adj('adj2', 50000)
    const x3 = sx + (ex - sx) * adj('adj3', 50000)
    d = [['M', sx, sy], ['L', x1, sy], ['L', x1, y2], ['L', x3, y2], ['L', x3, ey], ['L', ex, ey]]
  } else if (prst.startsWith('curvedConnector')) {
    const mx = sx + (ex - sx) * adj('adj1', 50000)
    d = [['M', sx, sy], ['C', mx, sy, mx, ey, ex, ey]]
    if (prst !== 'curvedConnector2' && prst !== 'curvedConnector3') ctx.env.warnings.add(`A curved connector on slide ${ctx.slideNo} is approximated by a simple curve.`)
  } else d = [['M', sx, sy], ['L', ex, ey]]
  out.push({ t: 'path', d, stroke })
  // arrow heads
  const pts: [number, number][] = []
  for (const s of d) if (s[0] === 'M' || s[0] === 'L') pts.push([s[1], s[2]])
  else if (s[0] === 'C') pts.push([s[5], s[6]])
  if (pts.length >= 2) {
    const lw = stroke.width
    const dirAt = (a: [number, number], b: [number, number]): number => Math.atan2(b[1] - a[1], b[0] - a[0])
    if (line.tail && line.tail !== 'none') out.push(...arrowHeadOps(pts[pts.length - 1][0], pts[pts.length - 1][1], dirAt(pts[pts.length - 2], pts[pts.length - 1]), lw, line.tail, line.tailSize, stroke.color, 1))
    if (line.head && line.head !== 'none') out.push(...arrowHeadOps(pts[0][0], pts[0][1], dirAt(pts[1], pts[0]), lw, line.head, line.headSize, stroke.color, 1))
  }
}

function renderConnector(ctx: Ctx, tree: Tree, cxn: XNode, xf: Xf, ops: Op[]): void {
  if (isTrue(attr(cNvPrOf(cxn), 'hidden'))) return
  const chain = chainFor(ctx, tree, cxn)
  const box = boxFrom(xfrmOf(chain), xf)
  if (!box) return
  const geom = geometryOf(chain)
  noteEffects(ctx, chain)
  const body: Op[] = []
  if (!LINE_PRESETS.has(geom.prst) && presetPath(geom.prst, box.w, box.h, geom.adj)) {
    const line = resolveLine(ctx, chain)
    const st = strokeOf(line, ctx)
    body.push({ t: 'path', d: mapPath(presetPath(geom.prst, box.w, box.h, geom.adj)!, (x) => x + box.x, (y) => y + box.y), stroke: st })
  } else drawLine(ctx, body, box, { ...geom, prst: LINE_PRESETS.has(geom.prst) ? geom.prst : 'line' }, resolveLine(ctx, chain))
  rotateWrap(ops, { ...box, rot: box.rot }, body)
}

// ---------------------------------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------------------------------

type LoadedImage = { ok: true; data: { bytes: Uint8Array; format: 'png' | 'jpeg' } } | { ok: false; fmt: string; data?: undefined }

function loadImage(ctx: Ctx, rid: string): LoadedImage | undefined {
  const rel = ctx.cur.rels.get(rid)
  if (!rel || rel.external) return undefined
  const bytes = ctx.pkg.bytes(rel.target)
  if (!bytes) return undefined
  const fmt = imageFormat(bytes)
  if (fmt === 'png' || fmt === 'jpeg') return { ok: true, data: { bytes, format: fmt } }
  return { ok: false, fmt }
}

function placeholderBox(ctx: Ctx, out: Op[], x: number, y: number, w: number, h: number, label: string): void {
  placeholderBoxShared(ctx.env, out, x, y, w, h, label)
}

function renderPic(ctx: Ctx, tree: Tree, pic: XNode, xf: Xf, ops: Op[], drawPh: boolean): void {
  if (isTrue(attr(cNvPrOf(pic), 'hidden'))) return
  const chain = chainFor(ctx, tree, pic)
  if (chain.ph && !drawPh) return
  const box = boxFrom(xfrmOf(chain), xf)
  if (!box) return
  const nvPr = nvPrOf(pic)
  if (child(nvPr, 'videoFile') || child(nvPr, 'audioFile') || child(nvPr, 'quickTimeFile')) {
    ctx.env.warnings.add(`A video or audio clip on slide ${ctx.slideNo} cannot be played in a PDF; its poster picture is shown instead.`)
  }
  noteEffects(ctx, chain)
  const bf = child(pic, 'blipFill')
  const blip = child(bf, 'blip')
  const rid = attr(blip, 'embed')
  const body: Op[] = []
  const name = attr(cNvPrOf(pic), 'name') ?? 'Picture'
  const img = rid ? loadImage(ctx, rid) : undefined
  const sr = child(bf, 'srcRect')
  const crop = sr ? { l: (numAttr(sr, 'l') ?? 0) / 100000, t: (numAttr(sr, 't') ?? 0) / 100000, r: (numAttr(sr, 'r') ?? 0) / 100000, b: (numAttr(sr, 'b') ?? 0) / 100000 } : undefined
  if (img?.ok) {
    const am = child(blip, 'alphaModFix')
    const opacity = am ? (numAttr(am, 'amt') ?? 100000) / 100000 : undefined
    const w = box.flipH ? -box.w : box.w
    const h = box.flipV ? -box.h : box.h
    const x = box.flipH ? box.x + box.w : box.x
    const y = box.flipV ? box.y + box.h : box.y
    body.push({ t: 'image', x, y, w, h, image: img.data, crop, opacity })
    const prst = attr(child(spPrOf(pic), 'prstGeom'), 'prst')
    if (prst && prst !== 'rect') ctx.env.warnings.add('Pictures cropped to a non-rectangular shape are shown as plain rectangles.')
  } else {
    const why = img ? `${img.fmt} pictures cannot be embedded` : 'the picture data is missing'
    ctx.env.warnings.add(`Slide ${ctx.slideNo}: “${name}” could not be drawn (${why}); a placeholder is shown.`)
    placeholderBox(ctx, body, box.x, box.y, box.w, box.h, img ? `Picture (${img.fmt.toUpperCase()})` : 'Picture')
  }
  const line = resolveLine(ctx, chain)
  const st = strokeOf(line, ctx)
  if (st && !line.none && (child(spPrOf(pic), 'ln'))) body.push({ t: 'rect', x: box.x, y: box.y, w: box.w, h: box.h, stroke: st })
  rotateWrap(ops, box, body)
}

// ---------------------------------------------------------------------------------------------------
// Groups and frames
// ---------------------------------------------------------------------------------------------------

function renderGroup(ctx: Ctx, tree: Tree, grp: XNode, xf: Xf, ops: Op[], drawPh: boolean): void {
  if (isTrue(attr(cNvPrOf(grp), 'hidden'))) return
  const pr = child(grp, 'grpSpPr')
  const x = child(pr, 'xfrm')
  const box = boxFrom(x, xf)
  let inner = xf
  if (x && box) {
    const off = child(x, 'off')
    const ext = child(x, 'ext')
    const cho = child(x, 'chOff')
    const che = child(x, 'chExt')
    const cw = numAttr(che, 'cx') || numAttr(ext, 'cx') || 1
    const ch = numAttr(che, 'cy') || numAttr(ext, 'cy') || 1
    const sx = (numAttr(ext, 'cx') ?? cw) / cw
    const sy = (numAttr(ext, 'cy') ?? ch) / ch
    const ax = xf.ax * sx
    const ay = xf.ay * sy
    inner = { ax, ay, bx: xf.ax * (numAttr(off, 'x') ?? 0) + xf.bx - ax * (numAttr(cho, 'x') ?? numAttr(off, 'x') ?? 0), by: xf.ay * (numAttr(off, 'y') ?? 0) + xf.by - ay * (numAttr(cho, 'y') ?? numAttr(off, 'y') ?? 0) }
  }
  const body: Op[] = []
  renderChildren(ctx, tree, grp, inner, body, drawPh)
  if (box && Math.abs(box.rot) > 0.01) rotateWrap(ops, box, body)
  else ops.push(...body)
}

function renderFrame(ctx: Ctx, tree: Tree, gf: XNode, xf: Xf, ops: Op[]): void {
  if (isTrue(attr(cNvPrOf(gf), 'hidden'))) return
  const chain = chainFor(ctx, tree, gf)
  const x = child(gf, 'xfrm')
  const box = boxFrom(x, xf) ?? boxFrom(xfrmOf(chain), xf)
  if (!box) return
  const gd = xpath(gf, 'graphic', 'graphicData')
  const uri = attr(gd, 'uri') ?? ''
  const name = attr(cNvPrOf(gf), 'name') ?? ''
  const tbl = child(gd, 'tbl')
  if (tbl) {
    renderTable(ctx, tbl, box, xf, ops)
    return
  }
  const kind = /chart/i.test(uri) ? 'Chart' : /diagram/i.test(uri) ? 'SmartArt diagram' : /ole|object|oleObj/i.test(uri) || child(gd, 'oleObj') ? 'Embedded object' : /media|video|audio/i.test(uri) ? 'Media' : 'Content'
  ctx.env.warnings.add(`${kind} “${name || kind}” on slide ${ctx.slideNo} is not rendered; a labelled placeholder is shown.`)
  const body: Op[] = []
  placeholderBox(ctx, body, box.x, box.y, box.w, box.h, name ? `${kind}: ${name}` : kind)
  rotateWrap(ops, box, body)
}

// ---------------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------------

function masterTxStyle(ctx: Ctx, ph: PhInfo | undefined): XNode | undefined {
  const tx = child(ctx.master?.root, 'txStyles')
  if (!tx) return undefined
  if (!ph) return child(tx, 'otherStyle')
  const c = phClass(ph.type)
  return child(tx, c === 'title' ? 'titleStyle' : c === 'body' ? 'bodyStyle' : 'otherStyle')
}

interface BodyProps {
  attrs: Record<string, string>
  autofit?: XNode
}

function mergeBodyPr(chain: Chain, txBody: XNode): BodyProps {
  const attrs: Record<string, string> = {}
  let autofit: XNode | undefined
  const nodes: XNode[] = []
  for (let i = chain.nodes.length - 1; i >= 0; i--) {
    const bp = child(i === 0 ? txBody : child(chain.nodes[i], 'txBody'), 'bodyPr')
    if (bp) nodes.push(bp)
  }
  for (const bp of nodes) {
    Object.assign(attrs, bp.attrs)
    for (const c of bp.children) if (c.name === 'normAutofit' || c.name === 'spAutoFit' || c.name === 'noAutofit') autofit = c
  }
  return { attrs, autofit }
}

const ALGN: Record<string, ParaProps['align']> = { l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify', justLow: 'justify', thaiDist: 'justify' }

function buildParagraphs(ctx: Ctx, tree: Tree, txBody: XNode, chain: XNode[], base: RPr, scale: number, lnRed: number): Block[] {
  const cc = ctx.cc
  const blocks: Block[] = []
  const counters: number[] = Array(10).fill(0)
  const autoType: (string | undefined)[] = Array(10).fill(undefined)
  let lastLvl = 0
  const paras = childrenNamed(txBody, 'p')
  paras.forEach((p, pi) => {
    const pPr = child(p, 'pPr')
    const lvl = Math.max(0, Math.min(8, numAttr(pPr, 'lvl') ?? 0))
    const pp: PPr = newPPr()
    for (const node of chain) applyPPr(pp, child(node, `lvl${lvl + 1}pPr`), cc)
    applyPPr(pp, pPr, cc)
    const styleFor = (rPrNode: XNode | undefined): { st: TextStyle; link?: string } => {
      // list styles first, then the shape/table style's colour and weight (fontRef, table style), then the run itself
      const layered: RPr = {}
      applyRPrInto(layered, pp.defRPr)
      applyRPrInto(layered, base)
      applyRPr(layered, rPrNode, cc)
      const size = (layered.sz ?? 18) * scale
      let color = layered.color?.hex ?? cc.theme.colors[cc.clrMap['tx1'] ?? 'dk1'] ?? '000000'
      if (!color.startsWith('#')) color = '#' + color
      let underline = !!layered.u
      let link: string | undefined
      if (layered.link) {
        const rel = tree.rels.get(layered.link)
        if (rel && rel.external && /^(https?:\/\/|mailto:)/i.test(rel.target)) {
          link = rel.target
          color = '#' + (cc.theme.colors['hlink'] ?? '0563c1')
          underline = true
        }
      }
      const csFamily = layered.csFamily ?? cc.theme.minorCs
      return {
        st: {
          ...(csFamily ? { cs: { family: csFamily } } : {}),
          family: layered.family ?? cc.theme.minor,
          size: Math.max(1, size),
          bold: !!layered.b,
          italic: !!layered.i,
          underline,
          strike: !!layered.strike,
          color,
          highlight: layered.highlight?.hex,
          vertAlign: layered.baseline ? (layered.baseline > 0 ? 'super' : 'sub') : undefined,
          caps: layered.caps,
          spacing: layered.spc
        },
        link
      }
    }
    const inlines: Inline[] = []
    let hasText = false
    let firstStyle: TextStyle | undefined
    for (const c of p.children) {
      if (c.name === 'r' || c.name === 'fld') {
        const { st, link } = styleFor(child(c, 'rPr'))
        firstStyle ??= st
        let text = child(c, 't')?.text ?? ''
        if (c.name === 'fld' && /slidenum/i.test(attr(c, 'type') ?? '')) text = String(ctx.slideNo)
        if (text) hasText = true
        inlines.push({ k: 'text', text, style: st, link })
      } else if (c.name === 'br') {
        const { st } = styleFor(child(c, 'rPr'))
        firstStyle ??= st
        inlines.push({ k: 'br', type: 'line', style: st })
      }
    }
    const markStyle = styleFor(child(p, 'endParaRPr')).st
    firstStyle ??= markStyle
    // numbering
    let marker: Paragraph['props']['marker']
    if (lvl < lastLvl) for (let l = lvl + 1; l < 10; l++) (counters[l] = 0), (autoType[l] = undefined)
    if (pp.buAutoNum && !pp.buNone) {
      if (autoType[lvl] !== pp.buAutoNum.type || counters[lvl] === 0) counters[lvl] = pp.buAutoNum.startAt - 1
      counters[lvl]++
      autoType[lvl] = pp.buAutoNum.type
      for (let l = lvl + 1; l < 10; l++) (counters[l] = 0), (autoType[l] = undefined)
      if (hasText) marker = markerStyle(pp, firstStyle, autoNumText(pp.buAutoNum.type, counters[lvl]), undefined)
    } else {
      counters[lvl] = 0
      autoType[lvl] = undefined
      if (pp.buChar && !pp.buNone && hasText) marker = markerStyle(pp, firstStyle, bulletText(pp.buChar, pp.buFont), pp.buFont)
    }
    lastLvl = lvl
    let left = pp.marL ?? 0
    let first = pp.indent ?? 0
    if (marker && first >= 0) {
      left = left + first + 18
      first = -18
    }
    const sizeRef = firstStyle.size
    const sp = (s: PPr['spcBef']): number => (!s ? 0 : s.pts !== undefined ? s.pts * scale : (s.pct ?? 0) * sizeRef * 1.2)
    const line: ParaProps['line'] = pp.lnSpc?.pts !== undefined ? { rule: 'exact', value: pp.lnSpc.pts * scale } : { rule: 'auto', value: (pp.lnSpc?.pct ?? 1) * (1 - lnRed) }
    const props: ParaProps = {
      ...DEFAULT_PARA_PROPS,
      // DrawingML algn is physical (PowerPoint and LibreOffice draw algn="r" at the right in any direction);
      // ParaProps.align is logical, so it is swapped for right-to-left paragraphs. marL/indent are logical (start).
      align: logicalAlign(ALGN[pp.algn ?? (pp.rtl ? 'r' : 'l')] ?? 'left', !!pp.rtl),
      spaceBefore: pi === 0 ? 0 : sp(pp.spcBef),
      spaceAfter: sp(pp.spcAft),
      line,
      indentLeft: left,
      firstLine: first,
      widowControl: false,
      tabs: (pp.tabs ?? []).map((t) => ({ pos: t.pos, align: t.algn === 'ctr' ? 'center' : t.algn === 'r' ? 'right' : t.algn === 'dec' ? 'decimal' : 'left' })),
      rtl: pp.rtl,
      marker
    }
    blocks.push({ k: 'p', props, inlines, markStyle })
  })
  return blocks
}

/** Physical alignment -> logical (start/end) for a right-to-left paragraph. */
export function logicalAlign(a: ParaProps['align'], rtl: boolean): ParaProps['align'] {
  return rtl ? (a === 'left' ? 'right' : a === 'right' ? 'left' : a) : a
}

function applyRPrInto(target: RPr, src: RPr): void {
  for (const k of Object.keys(src) as (keyof RPr)[]) if (src[k] !== undefined) (target as Record<string, unknown>)[k] = src[k]
}

function markerStyle(pp: PPr, first: TextStyle, text: string, buFont: string | undefined): NonNullable<ParaProps['marker']> {
  const symbolFont = buFont && /wingdings|symbol|webdings/i.test(buFont)
  return {
    text,
    style: {
      ...first,
      underline: false,
      strike: false,
      link: undefined,
      family: buFont && !symbolFont ? buFont : first.family,
      size: first.size * (pp.buSzPct ?? 1),
      color: pp.buClr?.hex ?? first.color
    } as TextStyle
  }
}

function renderTextBody(ctx: Ctx, tree: Tree, chain: Chain, txBody: XNode, area: { x: number; y: number; w: number; h: number }, fontColor: Rgba | undefined, isTextBox: boolean): Op[] {
  void isTextBox
  const hasContent = txBody.children.some((p) => p.name === 'p' && p.children.some((c) => (c.name === 'r' || c.name === 'fld' || c.name === 'br') ))
  if (!hasContent) return []
  const bp = mergeBodyPr(chain, txBody)
  const at = bp.attrs
  const lIns = (numAttr({ attrs: at } as XNode, 'lIns') ?? 91440) / EMU_PER_PT
  const tIns = (numAttr({ attrs: at } as XNode, 'tIns') ?? 45720) / EMU_PER_PT
  const rIns = (numAttr({ attrs: at } as XNode, 'rIns') ?? 91440) / EMU_PER_PT
  const bIns = (numAttr({ attrs: at } as XNode, 'bIns') ?? 45720) / EMU_PER_PT
  const innerW = Math.max(1, area.w - lIns - rIns)
  const innerH = Math.max(1, area.h - tIns - bIns)
  const vert = at['vert']
  if (vert && vert !== 'horz') ctx.env.warnings.add(`Vertical or rotated text on slide ${ctx.slideNo} is shown horizontally.`)
  const noWrap = at['wrap'] === 'none'
  const styleChain: XNode[] = []
  if (ctx.presDefault) styleChain.push(ctx.presDefault)
  if (chain.ph) {
    const ms = masterTxStyle(ctx, chain.ph)
    if (ms) styleChain.push(ms)
  }
  for (let i = chain.nodes.length - 1; i >= 0; i--) {
    const ls = child(child(chain.nodes[i], 'txBody'), 'lstStyle')
    if (ls) styleChain.push(ls)
  }
  const base: RPr = {}
  if (fontColor) base.color = fontColor
  const naf = bp.autofit && bp.autofit.name === 'normAutofit' ? bp.autofit : undefined
  let scale = naf ? (numAttr(naf, 'fontScale') ?? 100000) / 100000 : 1
  const lnRed = naf ? (numAttr(naf, 'lnSpcReduction') ?? 0) / 100000 : 0
  const doLayout = (s: number, red: number): { lay: ReturnType<typeof layoutTextBlock>; width: number } => {
    const blocks = buildParagraphs(ctx, tree, txBody, styleChain, base, s, red)
    if (noWrap) {
      const probe = layoutTextBlock(ctx.env, blocks, 100000)
      const width = Math.max(innerW, probe.extent + 1)
      return { lay: layoutTextBlock(ctx.env, blocks, width), width }
    }
    return { lay: layoutTextBlock(ctx.env, blocks, innerW), width: innerW }
  }
  let res = doLayout(scale, lnRed)
  if (naf && numAttr(naf, 'fontScale') === undefined && res.lay.height > innerH) {
    // The file did not record the shrink PowerPoint would apply; find one that fits.
    for (const s of [0.9, 0.8, 0.7, 0.6, 0.5]) {
      scale = s
      res = doLayout(s, 0.1)
      if (res.lay.height <= innerH) break
    }
  }
  const anchor = at['anchor'] ?? 't'
  const dy = anchor === 'ctr' ? (innerH - res.lay.height) / 2 : anchor === 'b' ? innerH - res.lay.height : 0
  let dx = 0
  if (noWrap) {
    const first = childrenNamed(txBody, 'p')[0]
    const algn = attr(child(first, 'pPr'), 'algn') ?? 'l'
    dx = algn === 'ctr' ? (innerW - res.width) / 2 : algn === 'r' ? innerW - res.width : 0
  }
  return shiftOps(res.lay.ops, area.x + lIns + dx, area.y + tIns + dy)
}

// ---------------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------------

interface CellStyle {
  fill?: Rgba | null
  bold?: boolean
  color?: Rgba
  borders: Partial<Record<'left' | 'right' | 'top' | 'bottom' | 'insideH' | 'insideV', LineSpec | null>>
}

interface TblStyle {
  whole?: CellStyle
  band1H?: CellStyle
  band2H?: CellStyle
  firstRow?: CellStyle
  lastRow?: CellStyle
  firstCol?: CellStyle
  lastCol?: CellStyle
}

const MEDIUM2_ACCENT1 = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'

function parseCellStyle(ctx: Ctx, part: XNode | undefined): CellStyle | undefined {
  if (!part) return undefined
  const cs: CellStyle = { borders: {} }
  const tx = child(part, 'tcTxStyle')
  if (tx) {
    if (attr(tx, 'b') === 'on') cs.bold = true
    const col = findColor(tx, ctx.cc.theme, ctx.cc.clrMap) ?? findColor(child(tx, 'fontRef'), ctx.cc.theme, ctx.cc.clrMap)
    if (col) cs.color = col
  }
  const tc = child(part, 'tcStyle')
  const fill = child(tc, 'fill')
  if (fill) {
    const f = readFill(fill, ctx.cc)
    if (f?.kind === 'solid' || f?.kind === 'grad') cs.fill = f.color
    else if (f?.kind === 'none') cs.fill = null
  }
  const fillRef = child(tc, 'fillRef')
  if (fillRef && cs.fill === undefined) {
    const col = findColor(fillRef, ctx.cc.theme, ctx.cc.clrMap)
    if (col && (numAttr(fillRef, 'idx') ?? 0) > 0) cs.fill = col
  }
  const bdr = child(tc, 'tcBdr')
  for (const side of ['left', 'right', 'top', 'bottom', 'insideH', 'insideV'] as const) {
    const s = child(bdr, side)
    if (!s) continue
    const ln = child(s, 'ln')
    if (ln) cs.borders[side] = readLine(ln, ctx.cc) ?? null
    else {
      const ref = child(s, 'lnRef')
      if (ref) {
        const idx = numAttr(ref, 'idx') ?? 0
        const col = findColor(ref, ctx.cc.theme, ctx.cc.clrMap)
        const node = ctx.cc.theme.lnStyles[Math.min(idx, ctx.cc.theme.lnStyles.length) - 1]
        const l = idx > 0 && node ? readLine(node, ctx.cc, col ?? undefined) : undefined
        cs.borders[side] = idx === 0 ? { none: true } : { none: false, width: l?.width ?? 1, color: l?.color ?? col ?? undefined }
      }
    }
  }
  return cs
}

function tableStyleFor(ctx: Ctx, id: string | undefined): TblStyle {
  if (id && ctx.tableStyles) {
    const st = ctx.tableStyles.children.find((c) => c.name === 'tblStyle' && attr(c, 'styleId') === id)
    if (st) {
      return {
        whole: parseCellStyle(ctx, child(st, 'wholeTbl')),
        band1H: parseCellStyle(ctx, child(st, 'band1H')),
        band2H: parseCellStyle(ctx, child(st, 'band2H')),
        firstRow: parseCellStyle(ctx, child(st, 'firstRow')),
        lastRow: parseCellStyle(ctx, child(st, 'lastRow')),
        firstCol: parseCellStyle(ctx, child(st, 'firstCol')),
        lastCol: parseCellStyle(ctx, child(st, 'lastCol'))
      }
    }
  }
  const th = ctx.cc.theme
  const accent = { hex: '#' + (th.colors['accent1'] ?? '4472c4'), alpha: 1 }
  const tint = (a: number): Rgba => {
    const h = accent.hex.replace('#', '')
    const c = [0, 2, 4].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) + (255 - parseInt(h.slice(i, i + 2), 16)) * (1 - a)))
    return { hex: '#' + c.map((v) => v.toString(16).padStart(2, '0')).join(''), alpha: 1 }
  }
  const white: LineSpec = { none: false, width: 1, color: { hex: '#ffffff', alpha: 1 } }
  if (!id || id === MEDIUM2_ACCENT1) {
    return {
      whole: { fill: tint(0.2), borders: { left: white, right: white, top: white, bottom: white, insideH: white, insideV: white } },
      band1H: { fill: tint(0.4), borders: {} },
      firstRow: { fill: accent, bold: true, color: { hex: '#ffffff', alpha: 1 }, borders: { bottom: { none: false, width: 3, color: { hex: '#ffffff', alpha: 1 } } } },
      firstCol: { bold: true, color: { hex: '#ffffff', alpha: 1 }, fill: accent, borders: {} },
      lastRow: { bold: true, borders: { top: { none: false, width: 3, color: { hex: '#ffffff', alpha: 1 } } } }
    }
  }
  const grid: LineSpec = { none: false, width: 0.75, color: { hex: '#000000', alpha: 1 } }
  return { whole: { borders: { left: grid, right: grid, top: grid, bottom: grid, insideH: grid, insideV: grid } } }
}

const toBorder = (l: LineSpec | null | undefined): BorderSpec | null | undefined => {
  if (l === undefined) return undefined
  if (l === null || l.none) return null
  const width = l.width ?? 0.75
  return { color: l.color?.hex ?? '#000000', width: Math.max(0.25, width), style: l.dash && /dash/i.test(l.dash) ? 'dashed' : l.dash && /dot/i.test(l.dash) ? 'dotted' : 'single' }
}

function renderTable(ctx: Ctx, tbl: XNode, box: Box, xf: Xf, ops: Op[]): void {
  const tblPr = child(tbl, 'tblPr')
  const style = tableStyleFor(ctx, child(tblPr, 'tableStyleId')?.text.trim())
  const firstRow = isTrue(attr(tblPr, 'firstRow'))
  const lastRow = isTrue(attr(tblPr, 'lastRow'))
  const firstCol = isTrue(attr(tblPr, 'firstCol'))
  const lastCol = isTrue(attr(tblPr, 'lastCol'))
  const bandRow = isTrue(attr(tblPr, 'bandRow'))
  const cols = childrenNamed(child(tbl, 'tblGrid'), 'gridCol').map((g) => (numAttr(g, 'w') ?? 0) * xf.ax)
  const trs = childrenNamed(tbl, 'tr')
  const nRows = trs.length
  const nCols = cols.length
  const rows: Row[] = []
  const cellDefault = { marL: 91440 / EMU_PER_PT, marR: 91440 / EMU_PER_PT, marT: 45720 / EMU_PER_PT, marB: 45720 / EMU_PER_PT }
  trs.forEach((tr, ri) => {
    const cells: Cell[] = []
    let ci = 0
    const tcs = childrenNamed(tr, 'tc')
    for (const tc of tcs) {
      const col = ci
      const span = numAttr(tc, 'gridSpan') ?? 1
      ci += 1
      if (isTrue(attr(tc, 'hMerge')) || isTrue(attr(tc, 'vMerge'))) continue
      // layered table style for this cell
      const layers: (CellStyle | undefined)[] = [style.whole]
      if (bandRow) {
        const bodyIdx = ri - (firstRow ? 1 : 0)
        if (bodyIdx >= 0) layers.push(bodyIdx % 2 === 0 ? style.band1H : style.band2H)
      }
      if (firstCol && col === 0) layers.push(style.firstCol)
      if (lastCol && col === nCols - 1) layers.push(style.lastCol)
      if (firstRow && ri === 0) layers.push(style.firstRow)
      if (lastRow && ri === nRows - 1) layers.push(style.lastRow)
      let fill: Rgba | null | undefined
      let bold: boolean | undefined
      let color: Rgba | undefined
      const edge: Partial<Record<'left' | 'right' | 'top' | 'bottom', LineSpec | null>> = {}
      const rowSpan = numAttr(tc, 'rowSpan') ?? 1
      for (const l of layers) {
        if (!l) continue
        if (l.fill !== undefined) fill = l.fill
        if (l.bold !== undefined) bold = l.bold
        if (l.color) color = l.color
        const b = l.borders
        const left = col === 0 ? b.left : b.insideV
        const right = col + span >= nCols ? b.right : b.insideV
        const top = ri === 0 ? b.top : b.insideH
        const bottom = ri + rowSpan >= nRows ? b.bottom : b.insideH
        if (left !== undefined) edge.left = left
        if (right !== undefined) edge.right = right
        if (top !== undefined) edge.top = top
        if (bottom !== undefined) edge.bottom = bottom
        // an explicit border on an inner edge of a layer (e.g. firstRow bottom) applies regardless of position
        if (l.borders.bottom !== undefined && ri !== nRows - 1 && l === style.firstRow) edge.bottom = l.borders.bottom
        if (l.borders.top !== undefined && ri !== 0 && l === style.lastRow) edge.top = l.borders.top
      }
      const tcPr = child(tc, 'tcPr')
      const own = readFill(tcPr, ctx.cc)
      if (own) fill = own.kind === 'solid' || own.kind === 'grad' ? own.color : null
      const borders: NonNullable<Cell['borders']> = {}
      for (const side of ['left', 'right', 'top', 'bottom'] as const) {
        const ownName = side === 'left' ? 'lnL' : side === 'right' ? 'lnR' : side === 'top' ? 'lnT' : 'lnB'
        const own = child(tcPr, ownName)
        const spec = own ? (readLine(own, ctx.cc) ?? null) : edge[side]
        const b = toBorder(spec)
        if (b !== undefined) borders[side] = b
      }
      const pad = {
        left: (numAttr(tcPr, 'marL') ?? cellDefault.marL * EMU_PER_PT) / EMU_PER_PT,
        right: (numAttr(tcPr, 'marR') ?? cellDefault.marR * EMU_PER_PT) / EMU_PER_PT,
        top: (numAttr(tcPr, 'marT') ?? cellDefault.marT * EMU_PER_PT) / EMU_PER_PT,
        bottom: (numAttr(tcPr, 'marB') ?? cellDefault.marB * EMU_PER_PT) / EMU_PER_PT
      }
      const anchor = attr(tcPr, 'anchor')
      const base: RPr = {}
      if (bold) base.b = true
      if (color) base.color = color
      const txBody = child(tc, 'txBody')
      const chain = ctx.presDefault ? [ctx.presDefault] : []
      let blocks: Block[] = txBody ? buildParagraphs(ctx, ctx.cur, txBody, chain, base, 1, 0) : []
      if (blocks.length === 0) blocks = [{ k: 'p', props: { ...DEFAULT_PARA_PROPS }, inlines: [], markStyle: { family: ctx.cc.theme.minor, size: 18, bold: false, italic: false, underline: false, strike: false, color: '#000000' } }]
      cells.push({ blocks, colSpan: span, rowSpan, shading: fill ? fill.hex : undefined, borders, padding: pad, vAlign: anchor === 'ctr' ? 'center' : anchor === 'b' ? 'bottom' : 'top' })
      if (span > 1) ci += span - 1
    }
    rows.push({ cells, height: { value: (numAttr(tr, 'h') ?? 0) * xf.ay, rule: 'atLeast' }, header: false, cantSplit: true })
  })
  // a:tblPr rtl="1": right-to-left table (first column on the right)
  const table: Table = { k: 'table', colWidths: cols, rows, borders: {}, padding: { top: 3.6, right: 7.2, bottom: 3.6, left: 7.2 }, align: 'left', indent: 0, rtl: isTrue(attr(tblPr, 'rtl')) || undefined }
  const frags = tableFragments({ catalog: ctx.env.catalog, warnings: ctx.env.warnings, defaultTabStop: 72, maxBlockHeight: 100000 }, table, cols.reduce((s, w) => s + w, 0) + (table.rtl ? 0 : 1))
  const st = stackFragments(frags)
  const body = shiftOps(st.ops, box.x, box.y)
  rotateWrap(ops, box, body)
}
