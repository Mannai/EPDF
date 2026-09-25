import type { Block, FlowDocument, FloatSpec, Section } from './flow'
import type { FontCatalog } from './fonts'
import { blocksToFragments, shiftOps, splitFragment, stackFragments, type Fragment, type LayoutContext } from './layout'
import type { Op, Page, Warnings } from './ops'

const EPS = 0.01

export interface PaginateOptions {
  signal?: AbortSignal
  onProgress?: (fraction: number, message?: string) => void
}

interface PageInfo {
  page: Page
  section: Section
  indexInSection: number
  number: number
  behind: Op[]
  front: Op[]
}

type Kind = 'default' | 'first' | 'even'

const kindOf = (s: Section, indexInSection: number, number: number): Kind => {
  if (s.titlePg && indexInSection === 0) return 'first'
  if (s.evenAndOdd && number % 2 === 0) return 'even'
  return 'default'
}

function pickBlocks(set: Section['header'], kind: Kind): Block[] | undefined {
  if (!set) return undefined
  return set[kind] ?? set.default
}

/** Lays a flow document out into pages (display lists). */
export function paginateFlow(doc: FlowDocument, catalog: FontCatalog, warnings: Warnings, opts: PaginateOptions = {}): Page[] {
  const infos: PageInfo[] = []
  let nextNumber = 1
  const ctxFor = (maxBlockHeight: number, page?: number, pages?: number): LayoutContext => ({ catalog, warnings, defaultTabStop: doc.defaultTabStop, maxBlockHeight, page, pages })

  // Header/footer heights per section+kind (measured with placeholder numbers).
  const hfHeight = (blocks: Block[] | undefined, width: number, maxH: number): number => {
    if (!blocks || blocks.length === 0) return 0
    return stackFragments(blocksToFragments(ctxFor(maxH, 1, 1), blocks, width)).height
  }

  let cur: PageInfo | null = null
  let y = 0
  let col = 0
  let region = { top: 0, bottom: 0, left: 0, colW: 0, colGap: 0, cols: 1 }

  const setRegion = (info: PageInfo): void => {
    const s = info.section
    const m = s.page.margins
    const kind = kindOf(s, info.indexInSection, info.number)
    const width = s.page.width - m.left - m.right
    const hH = hfHeight(pickBlocks(s.header, kind), width, s.page.height / 2)
    const fH = hfHeight(pickBlocks(s.footer, kind), width, s.page.height / 2)
    const top = Math.max(m.top, hH > 0 ? m.header + hH : 0)
    const bottom = s.page.height - Math.max(m.bottom, fH > 0 ? m.footer + fH : 0)
    const cols = Math.max(1, s.columns?.count ?? 1)
    const gap = s.columns?.gap ?? 36
    const colW = cols > 1 ? (width - gap * (cols - 1)) / cols : width
    region = { top, bottom: Math.max(bottom, top + 20), left: m.left, colW, colGap: gap, cols }
  }

  const startPage = (s: Section, indexInSection: number): void => {
    const page: Page = { width: s.page.width, height: s.page.height, ops: [] }
    cur = { page, section: s, indexInSection, number: nextNumber++, behind: [], front: [] }
    infos.push(cur)
    setRegion(cur)
    y = region.top
    col = 0
  }

  const advance = (): void => {
    if (!cur) return
    if (col + 1 < region.cols) {
      col++
      y = region.top
    } else startPage(cur.section, cur.indexInSection + 1)
  }

  const colX = (): number => region.left + col * (region.colW + region.colGap)

  const resolveFloat = (fl: FloatSpec, fragTopY: number): Op | null => {
    if (!cur) return null
    const s = cur.section
    const pageW = s.page.width
    const pageH = s.page.height
    const m = s.page.margins
    let x: number
    const baseW = fl.hRel === 'page' ? pageW : pageW - m.left - m.right
    const baseX = fl.hRel === 'page' ? 0 : m.left
    if (fl.hAlign === 'center') x = baseX + (baseW - fl.w) / 2
    else if (fl.hAlign === 'right') x = baseX + baseW - fl.w
    else if (fl.hAlign === 'left') x = baseX
    else x = (fl.hRel === 'column' || fl.hRel === 'character' ? colX() : baseX) + fl.hOffset
    let yy: number
    const baseH = fl.vRel === 'page' ? pageH : pageH - m.top - m.bottom
    const baseY = fl.vRel === 'page' ? 0 : m.top
    if (fl.vAlign === 'center') yy = baseY + (baseH - fl.h) / 2
    else if (fl.vAlign === 'bottom') yy = baseY + baseH - fl.h
    else if (fl.vAlign === 'top') yy = baseY
    else if (fl.vRel === 'paragraph' || fl.vRel === 'line') yy = fragTopY + fl.vOffset
    else yy = baseY + fl.vOffset
    return { t: 'image', x, y: yy, w: fl.w, h: fl.h, image: fl.image, crop: fl.crop }
  }

  const emit = (f: Fragment): void => {
    if (!cur) return
    cur.page.ops.push(...shiftOps(f.ops, colX(), y))
    if (f.floats) {
      for (const fl of f.floats) {
        const op = resolveFloat(fl, y)
        if (op) (fl.behind ? cur.behind : cur.front).push(op)
      }
    }
  }

  const sections = doc.sections
  let totalFrags = 0
  const perSection: Fragment[][] = []
  // Fragments depend on the section's column width; build lazily per section below.
  void totalFrags
  void perSection

  sections.forEach((s, si) => {
    if (opts.signal?.aborted) throw new Error('Cancelled')
    opts.onProgress?.(si / sections.length, `Laying out section ${si + 1} of ${sections.length}`)
    if (s.pageNumberStart !== undefined) nextNumber = s.pageNumberStart
    const samePageSetup =
      cur &&
      Math.abs(cur.section.page.width - s.page.width) < 1 &&
      Math.abs(cur.section.page.height - s.page.height) < 1
    const sameSection = cur && cur.section === s
    if (!cur || s.type === 'nextPage' || !samePageSetup) {
      if (cur && s.pageNumberStart === undefined) {
        /* numbering continues */
      }
      startPage(s, 0)
    } else if (!sameSection) {
      // continuous: keep the page but adopt the new section's column setup from here on
      cur.section = s
      const info: PageInfo = cur
      const width = s.page.width - s.page.margins.left - s.page.margins.right
      const cols = Math.max(1, s.columns?.count ?? 1)
      const gap = s.columns?.gap ?? 36
      region = { ...region, cols, colGap: gap, colW: cols > 1 ? (width - gap * (cols - 1)) / cols : width }
      col = 0
      void info
    }
    const bodyH = Math.max(50, region.bottom - region.top)
    const ctx = ctxFor(bodyH)
    const frags = blocksToFragments(ctx, s.blocks, region.colW)
    for (let fi = 0; fi < frags.length; fi++) {
      if (opts.signal?.aborted) throw new Error('Cancelled')
      if (fi % 64 === 0) opts.onProgress?.((si + fi / Math.max(1, frags.length)) / sections.length)
      let f = frags[fi]
      if (f.breakBefore && y > region.top + EPS) {
        // a page break always leaves the current column set
        if (cur) startPage(cur.section, cur.indexInSection + 1)
      }
      // keep-with-next chains
      if (f.keepNext) {
        let need = f.height
        let j = fi
        while (frags[j]?.keepNext && j + 1 < frags.length) {
          j++
          const nx = frags[j]
          need += nx.keepNext ? nx.height : (nx.breaks[0] ?? nx.height)
          if (need > bodyH) break
        }
        if (y > region.top + EPS && y + need > region.bottom + EPS && need <= bodyH) advance()
      }
      for (;;) {
        const availH = region.bottom - y
        if (f.height <= availH + EPS) {
          emit(f)
          y += f.height
          break
        }
        const fits = f.breaks.filter((b) => b <= availH + EPS && b > EPS)
        let at: number | undefined = fits.length ? fits[fits.length - 1] : undefined
        if (at === undefined) {
          if (y > region.top + EPS) {
            advance()
            continue
          }
          const soft = (f.softBreaks ?? []).filter((b) => b <= availH + EPS && b > EPS)
          at = soft.length ? soft[soft.length - 1] : undefined
          if (at === undefined) {
            emit(f) // cannot be split: draw it anyway rather than lose it
            y += f.height
            break
          }
        }
        const [head, tail] = splitFragment(f, at)
        emit(head)
        y += head.height
        advance()
        if (f.repeat) {
          const rep = f.repeat
          if (cur) cur.page.ops.push(...shiftOps(rep.ops, colX(), y))
          y += rep.height
          tail.height += 0
        }
        f = tail
      }
    }
  })
  if (infos.length === 0) startPage(sections[0], 0)

  // Headers and footers, now that the page count is known.
  const total = infos.length
  for (const info of infos) {
    const s = info.section
    const m = s.page.margins
    const width = s.page.width - m.left - m.right
    const kind = kindOf(s, info.indexInSection, info.number)
    const ctx = ctxFor(s.page.height / 2, info.number, doc.sections.length ? nextNumber - 1 : total)
    const hb = pickBlocks(s.header, kind)
    const fb = pickBlocks(s.footer, kind)
    if (hb && hb.length) {
      const f = stackFragments(blocksToFragments(ctx, hb, width))
      info.page.ops.push(...shiftOps(f.ops, m.left, m.header))
      pushFloats(info, f, m.header)
    }
    if (fb && fb.length) {
      const f = stackFragments(blocksToFragments(ctx, fb, width))
      const top = s.page.height - m.footer - f.height
      info.page.ops.push(...shiftOps(f.ops, m.left, top))
      pushFloats(info, f, top)
    }
    info.page.ops = [...info.behind, ...info.page.ops, ...info.front]
  }
  opts.onProgress?.(1)
  return infos.map((i) => i.page)

  function pushFloats(info: PageInfo, f: Fragment, topY: number): void {
    if (!f.floats) return
    const s = info.section
    for (const fl of f.floats) {
      const pageW = s.page.width
      const m = s.page.margins
      const baseW = fl.hRel === 'page' ? pageW : pageW - m.left - m.right
      const baseX = fl.hRel === 'page' ? 0 : m.left
      const x = fl.hAlign === 'center' ? baseX + (baseW - fl.w) / 2 : fl.hAlign === 'right' ? baseX + baseW - fl.w : baseX + fl.hOffset
      const baseH = fl.vRel === 'page' ? s.page.height : s.page.height - m.top - m.bottom
      const baseY = fl.vRel === 'page' ? 0 : m.top
      const yy =
        fl.vAlign === 'center' ? baseY + (baseH - fl.h) / 2 : fl.vAlign === 'bottom' ? baseY + baseH - fl.h : fl.vAlign === 'top' ? baseY : fl.vRel === 'paragraph' || fl.vRel === 'line' ? topY + fl.vOffset : baseY + fl.vOffset
      const op: Op = { t: 'image', x, y: yy, w: fl.w, h: fl.h, image: fl.image, crop: fl.crop }
      ;(fl.behind ? info.behind : info.front).push(op)
    }
  }
}
