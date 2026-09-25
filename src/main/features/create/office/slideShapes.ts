import type { Block } from './flow'
import type { ConvertEnv } from './env'
import { blocksToFragments, stackFragments, type Fragment } from './layout'
import type { Op, PathSeg } from './ops'

/** Geometry and text-box helpers shared by the PPTX and ODP converters. */

const K = 0.5522847498 // bezier circle constant

export function rectPath(w: number, h: number): PathSeg[] {
  return [['M', 0, 0], ['L', w, 0], ['L', w, h], ['L', 0, h], ['Z']]
}

export function roundRectPath(w: number, h: number, r: number): PathSeg[] {
  const q = Math.max(0, Math.min(r, w / 2, h / 2))
  if (q <= 0) return rectPath(w, h)
  const c = q * K
  return [
    ['M', q, 0],
    ['L', w - q, 0],
    ['C', w - q + c, 0, w, q - c, w, q],
    ['L', w, h - q],
    ['C', w, h - q + c, w - q + c, h, w - q, h],
    ['L', q, h],
    ['C', q - c, h, 0, h - q + c, 0, h - q],
    ['L', 0, q],
    ['C', 0, q - c, q - c, 0, q, 0],
    ['Z']
  ]
}

export function ellipsePath(w: number, h: number): PathSeg[] {
  const rx = w / 2
  const ry = h / 2
  const cx = rx
  const cy = ry
  return [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + ry * K, cx + rx * K, cy + ry, cx, cy + ry],
    ['C', cx - rx * K, cy + ry, cx - rx, cy + ry * K, cx - rx, cy],
    ['C', cx - rx, cy - ry * K, cx - rx * K, cy - ry, cx, cy - ry],
    ['C', cx + rx * K, cy - ry, cx + rx, cy - ry * K, cx + rx, cy],
    ['Z']
  ]
}

export function polygonPath(pts: [number, number][]): PathSeg[] {
  const d: PathSeg[] = pts.map((p, i) => (i === 0 ? (['M', p[0], p[1]] as PathSeg) : (['L', p[0], p[1]] as PathSeg)))
  d.push(['Z'])
  return d
}

function starPoints(w: number, h: number, n: number, innerRatio: number): [number, number][] {
  const R = h / (1 + Math.cos(Math.PI / n))
  const cy = R
  const halfW = R * Math.sin((Math.PI * 2 * Math.floor(n / 2)) / n)
  const sx = halfW > 0 ? w / 2 / halfW : 1
  const pts: [number, number][] = []
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? R : R * innerRatio
    const a = -Math.PI / 2 + (Math.PI * i) / n
    pts.push([w / 2 + Math.cos(a) * r * sx, cy + Math.sin(a) * r])
  }
  return pts
}

/**
 * Path for a preset geometry in shape-local points (origin top-left, y down), or null when the preset is not
 * implemented. `adj` maps adjust-value names (adj, adj1, ...) to their raw 1/100000 values.
 */
export function presetPath(prst: string, w: number, h: number, adj: Record<string, number>): PathSeg[] | null {
  const ss = Math.min(w, h)
  const a = (name: string, def: number): number => (adj[name] ?? def) / 100000
  switch (prst) {
    case 'rect':
    case 'flowChartProcess':
    case 'flowChartPredefinedProcess':
    case 'flowChartInternalStorage':
    case 'textBox':
    case 'frame':
      return rectPath(w, h)
    case 'roundRect':
    case 'flowChartAlternateProcess':
      return roundRectPath(w, h, ss * a('adj', 16667))
    case 'flowChartTerminator':
      return roundRectPath(w, h, ss / 2)
    case 'ellipse':
    case 'oval':
    case 'flowChartConnector':
      return ellipsePath(w, h)
    case 'triangle':
      return polygonPath([[w * a('adj', 50000), 0], [w, h], [0, h]])
    case 'rtTriangle':
      return polygonPath([[0, 0], [w, h], [0, h]])
    case 'diamond':
    case 'flowChartDecision':
      return polygonPath([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]])
    case 'parallelogram': {
      const x2 = ss * a('adj', 25000)
      return polygonPath([[0, h], [x2, 0], [w, 0], [w - x2, h]])
    }
    case 'trapezoid': {
      const x2 = ss * a('adj', 25000)
      return polygonPath([[0, h], [x2, 0], [w - x2, 0], [w, h]])
    }
    case 'pentagon':
      return polygonPath(starPoints(w, h, 5, 1).filter((_, i) => i % 2 === 0))
    case 'hexagon': {
      const x1 = ss * a('adj', 25000)
      return polygonPath([[0, h / 2], [x1, 0], [w - x1, 0], [w, h / 2], [w - x1, h], [x1, h]])
    }
    case 'octagon': {
      const x1 = ss * a('adj', 29289)
      return polygonPath([[x1, 0], [w - x1, 0], [w, x1], [w, h - x1], [w - x1, h], [x1, h], [0, h - x1], [0, x1]])
    }
    case 'homePlate': {
      const x = ss * a('adj', 50000)
      return polygonPath([[0, 0], [w - x, 0], [w, h / 2], [w - x, h], [0, h]])
    }
    case 'chevron': {
      const x = ss * a('adj', 50000)
      return polygonPath([[0, 0], [w - x, 0], [w, h / 2], [w - x, h], [0, h], [x, h / 2]])
    }
    case 'plus': {
      const x = ss * a('adj', 25000)
      return polygonPath([[x, 0], [w - x, 0], [w - x, x], [w, x], [w, h - x], [w - x, h - x], [w - x, h], [x, h], [x, h - x], [0, h - x], [0, x], [x, x]])
    }
    case 'rightArrow':
    case 'leftArrow': {
      const t = a('adj1', 50000)
      const head = ss * a('adj2', 50000)
      const y1 = (h * (1 - t)) / 2
      const y2 = h - y1
      const pts: [number, number][] = [[0, y1], [w - head, y1], [w - head, 0], [w, h / 2], [w - head, h], [w - head, y2], [0, y2]]
      return polygonPath(prst === 'leftArrow' ? pts.map(([x, y]) => [w - x, y] as [number, number]) : pts)
    }
    case 'upArrow':
    case 'downArrow': {
      const t = a('adj1', 50000)
      const head = ss * a('adj2', 50000)
      const x1 = (w * (1 - t)) / 2
      const x2 = w - x1
      const pts: [number, number][] = [[x1, h], [x1, head], [0, head], [w / 2, 0], [w, head], [x2, head], [x2, h]]
      return polygonPath(prst === 'downArrow' ? pts.map(([x, y]) => [x, h - y] as [number, number]) : pts)
    }
    case 'star5':
      return polygonPath(starPoints(w, h, 5, 0.382))
    case 'star4':
      return polygonPath(starPoints(w, h, 4, 0.4).map(([x, y]) => [x, y]))
    case 'star6':
      return polygonPath(starPoints(w, h, 6, 0.55))
    default:
      return null
  }
}

/** Text rectangle (fractions of the shape box) for presets whose text area is smaller than the box. */
export function presetTextInset(prst: string): { l: number; t: number; r: number; b: number } {
  switch (prst) {
    case 'ellipse':
    case 'oval':
    case 'flowChartConnector':
      return { l: 0.1464, t: 0.1464, r: 0.1464, b: 0.1464 }
    case 'diamond':
    case 'flowChartDecision':
      return { l: 0.25, t: 0.25, r: 0.25, b: 0.25 }
    case 'triangle':
      return { l: 0.25, t: 0.5, r: 0.25, b: 0 }
    default:
      return { l: 0, t: 0, r: 0, b: 0 }
  }
}

// ---------------------------------------------------------------------------------------------------
// Path transforms
// ---------------------------------------------------------------------------------------------------

export function mapPath(d: PathSeg[], fx: (x: number) => number, fy: (y: number) => number): PathSeg[] {
  return d.map((s): PathSeg => {
    if (s[0] === 'M' || s[0] === 'L') return [s[0], fx(s[1]), fy(s[2])]
    if (s[0] === 'C') return ['C', fx(s[1]), fy(s[2]), fx(s[3]), fy(s[4]), fx(s[5]), fy(s[6])]
    return s
  })
}

/** Converts an arc (SVG-style endpoint parameterisation) into cubic segments appended to `out`. */
function arcToBeziers(out: PathSeg[], x1: number, y1: number, rx: number, ry: number, phiDeg: number, fa: number, fs: number, x2: number, y2: number): void {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) {
    out.push(['L', x2, y2])
    return
  }
  const phi = (phiDeg * Math.PI) / 180
  const cosP = Math.cos(phi)
  const sinP = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cosP * dx + sinP * dy
  const y1p = -sinP * dx + cosP * dy
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lam > 1) {
    rx *= Math.sqrt(lam)
    ry *= Math.sqrt(lam)
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  let co = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den))
  if (fa === fs) co = -co
  const cxp = (co * rx * y1p) / ry
  const cyp = (-co * ry * x1p) / rx
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const s = ux * vy - uy * vx < 0 ? -1 : 1
    const dot = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy))
    return s * Math.acos(Math.max(-1, Math.min(1, dot)))
  }
  const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!fs && dth > 0) dth -= 2 * Math.PI
  else if (fs && dth < 0) dth += 2 * Math.PI
  const n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2)))
  const step = dth / n
  const t = (4 / 3) * Math.tan(step / 4)
  let a = th1
  for (let i = 0; i < n; i++) {
    const cosA = Math.cos(a)
    const sinA = Math.sin(a)
    const cosB = Math.cos(a + step)
    const sinB = Math.sin(a + step)
    const p = (ex: number, ey: number): [number, number] => [cosP * rx * ex - sinP * ry * ey + cx, sinP * rx * ex + cosP * ry * ey + cy]
    const c1 = p(cosA - t * sinA, sinA + t * cosA)
    const c2 = p(cosB + t * sinB, sinB - t * cosB)
    const e = p(cosB, sinB)
    out.push(['C', c1[0], c1[1], c2[0], c2[1], e[0], e[1]])
    a += step
  }
}

/** Parses SVG path data (M L H V C S Q T A Z, absolute and relative) into PathSegs. */
export function parseSvgPath(d: string): PathSeg[] {
  const out: PathSeg[] = []
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? []
  let i = 0
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  let cmd = ''
  let lastC: [number, number] | null = null
  let lastQ: [number, number] | null = null
  const num = (): number => parseFloat(tokens[i++])
  const isNum = (): boolean => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i])
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) cmd = tokens[i++]
    else if (cmd === 'M') cmd = 'L'
    else if (cmd === 'm') cmd = 'l'
    const rel = cmd === cmd.toLowerCase()
    const up = cmd.toUpperCase()
    const ox = rel ? cx : 0
    const oy = rel ? cy : 0
    let nextC: [number, number] | null = null
    let nextQ: [number, number] | null = null
    if (up === 'Z') {
      out.push(['Z'])
      cx = sx
      cy = sy
      continue
    }
    if (!isNum()) break
    switch (up) {
      case 'M': {
        cx = ox + num()
        cy = oy + num()
        sx = cx
        sy = cy
        out.push(['M', cx, cy])
        break
      }
      case 'L':
        cx = ox + num()
        cy = oy + num()
        out.push(['L', cx, cy])
        break
      case 'H':
        cx = ox + num()
        out.push(['L', cx, cy])
        break
      case 'V':
        cy = oy + num()
        out.push(['L', cx, cy])
        break
      case 'C': {
        const x1 = ox + num()
        const y1 = oy + num()
        const x2 = ox + num()
        const y2 = oy + num()
        cx = ox + num()
        cy = oy + num()
        out.push(['C', x1, y1, x2, y2, cx, cy])
        nextC = [x2, y2]
        break
      }
      case 'S': {
        const x2 = ox + num()
        const y2 = oy + num()
        const x1 = lastC ? 2 * cx - lastC[0] : cx
        const y1 = lastC ? 2 * cy - lastC[1] : cy
        cx = ox + num()
        cy = oy + num()
        out.push(['C', x1, y1, x2, y2, cx, cy])
        nextC = [x2, y2]
        break
      }
      case 'Q':
      case 'T': {
        let qx: number
        let qy: number
        if (up === 'Q') {
          qx = ox + num()
          qy = oy + num()
        } else {
          qx = lastQ ? 2 * cx - lastQ[0] : cx
          qy = lastQ ? 2 * cy - lastQ[1] : cy
        }
        const ex = ox + num()
        const ey = oy + num()
        out.push(['C', cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey])
        cx = ex
        cy = ey
        nextQ = [qx, qy]
        break
      }
      case 'A': {
        const rx = num()
        const ry = num()
        const rot = num()
        const fa = num()
        const fs = num()
        const ex = ox + num()
        const ey = oy + num()
        arcToBeziers(out, cx, cy, rx, ry, rot, fa, fs, ex, ey)
        cx = ex
        cy = ey
        break
      }
      default:
        i = tokens.length
    }
    lastC = nextC
    lastQ = nextQ
  }
  return out
}

export function pathBounds(d: PathSeg[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const add = (x: number, y: number): void => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  for (const s of d) {
    if (s[0] === 'M' || s[0] === 'L') add(s[1], s[2])
    else if (s[0] === 'C') {
      add(s[1], s[2])
      add(s[3], s[4])
      add(s[5], s[6])
    }
  }
  if (!isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** A filled triangle/arrow head at (x,y) pointing in direction `angle` (radians). */
export function arrowHeadOps(x: number, y: number, angle: number, lineWidth: number, kind: string, sizeName: string | undefined, color: string, opacity: number): Op[] {
  if (kind === 'none' || !kind) return []
  const mul = sizeName === 'sm' ? 2 : sizeName === 'lg' ? 5 : 3
  const len = Math.max(lineWidth, 1) * mul
  const half = len * 0.5
  const ca = Math.cos(angle)
  const sa = Math.sin(angle)
  const pt = (dx: number, dy: number): [number, number] => [x + dx * ca - dy * sa, y + dx * sa + dy * ca]
  if (kind === 'oval') {
    const c = pt(-len / 2, 0)
    return [{ t: 'path', d: mapPath(ellipsePath(len, len), (px) => px + c[0] - len / 2, (py) => py + c[1] - len / 2), fill: color, opacity }]
  }
  const pts: [number, number][] =
    kind === 'diamond'
      ? [pt(0, 0), pt(-len / 2, half), pt(-len, 0), pt(-len / 2, -half)]
      : kind === 'stealth'
        ? [pt(0, 0), pt(-len, half), pt(-len * 0.7, 0), pt(-len, -half)]
        : [pt(0, 0), pt(-len, half), pt(-len, -half)]
  return [{ t: 'path', d: polygonPath(pts), fill: color, opacity }]
}

// ---------------------------------------------------------------------------------------------------
// Text blocks
// ---------------------------------------------------------------------------------------------------

export interface TextBlockLayout {
  height: number
  ops: Op[]
  /** Widest extent of any drawn text (x + width), for "no wrap" boxes. */
  extent: number
}

export function layoutTextBlock(env: ConvertEnv, blocks: Block[], width: number, defaultTab = 72): TextBlockLayout {
  const frags: Fragment[] = blocksToFragments({ catalog: env.catalog, warnings: env.warnings, defaultTabStop: defaultTab, maxBlockHeight: 100000 }, blocks, Math.max(1, width))
  const st = stackFragments(frags)
  let extent = 0
  for (const op of st.ops) {
    if (op.t === 'text') extent = Math.max(extent, op.x + env.catalog.measure(op.face, op.text) * op.size)
    else if (op.t === 'rect') extent = Math.max(extent, op.x + op.w)
  }
  return { height: st.height, ops: st.ops, extent }
}
