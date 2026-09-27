import { useEffect, useMemo, useState } from 'react'
import type { Pt } from './pdf/geometry'
import { NOTE_SIZE, STAMP_HEIGHT } from './pdf/appearance'
import { stampByName, type StampDef } from './pdf/stamps'
import { useMarkup, type CustomStamp } from './store'

/**
 * Placement previews: while a click-to-place tool is active, a see-through copy of what a click would add follows the
 * pointer, at its real size and where it would land (kept inside the page, as placing does). Nothing here is written to
 * the document; the layer ignores the mouse.
 */

const GHOST_OPACITY = 0.55

const css = (c: readonly number[]): string => `rgb(${c.map((v) => Math.round(v * 255)).join(' ')})`

let measureCtx: CanvasRenderingContext2D | null | undefined
/** Width of `text` in Helvetica Bold at `size` pt. Arial Bold has the same metrics and is what Windows has. */
function boldWidth(text: string, size: number): number {
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * size * 0.72
  measureCtx.font = `bold ${size}px Helvetica, Arial, sans-serif`
  return measureCtx.measureText(text).width
}

/** The upright size of a built-in stamp in points, as `stampSize` computes it for the PDF. */
export const ghostStampSize = (def: StampDef): [number, number] => [Math.round(boldWidth(def.label, 22) + (def.shape === 'arrow' ? 56 : 34)), STAMP_HEIGHT]

/** Centre `at` moved so a `w × h` box stays on the page (CSS px). */
function clampBox(at: Pt, w: number, h: number, pageW: number, pageH: number): { left: number; top: number } {
  const cx = w >= pageW ? pageW / 2 : Math.min(Math.max(at[0], w / 2), pageW - w / 2)
  const cy = h >= pageH ? pageH / 2 : Math.min(Math.max(at[1], h / 2), pageH - h / 2)
  return { left: cx - w / 2, top: cy - h / 2 }
}

function BuiltInStampGhost({ def, at, scale, pageW, pageH }: { def: StampDef; at: Pt; scale: number; pageW: number; pageH: number }): JSX.Element {
  const [wPt, hPt] = ghostStampSize(def)
  const w = wPt * scale
  const h = hPt * scale
  const arrow = def.shape === 'arrow'
  const pos = clampBox(at, w, h, pageW, pageH)
  const inner = (arrow ? wPt - 30 : wPt - 16) * scale
  let size = Math.min(hPt * 0.5, 26)
  while (size > 6 && boldWidth(def.label, size) * scale > inner) size -= 0.5
  const tip = h / 2
  return (
    <svg data-testid="place-ghost" data-ghost="stamp" className="pointer-events-none absolute" style={{ ...pos, width: w, height: h, opacity: GHOST_OPACITY }} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {arrow ? (
        <path d={`M1.5 1.5 L${w - tip - 1} 1.5 L${w - 1.5} ${h / 2} L${w - tip - 1} ${h - 1.5} L1.5 ${h - 1.5} Z`} fill="rgb(255 217 51)" stroke={css(def.color)} strokeWidth={1.6 * scale} />
      ) : (
        <rect x={1.5 * scale} y={1.5 * scale} width={w - 3 * scale} height={h - 3 * scale} rx={Math.min(8, hPt / 4) * scale} fill="none" stroke={css(def.color)} strokeWidth={2.6 * scale} />
      )}
      <text
        x={arrow ? (w - h / 2) / 2 : w / 2}
        y={h / 2 + size * 0.36 * scale}
        textAnchor="middle"
        fontFamily="Helvetica, Arial, sans-serif"
        fontWeight="bold"
        fontSize={size * scale}
        fill={arrow ? 'rgb(26 26 38)' : css(def.color)}
      >
        {def.label}
      </text>
    </svg>
  )
}

function ImageStampGhost({ stamp, at, scale, pageW, pageH }: { stamp: CustomStamp; at: Pt; scale: number; pageW: number; pageH: number }): JSX.Element | null {
  const url = useMemo(() => URL.createObjectURL(new Blob([stamp.bytes.slice()], { type: stamp.kind === 'png' ? 'image/png' : 'image/jpeg' })), [stamp])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  const [natural, setNatural] = useState<[number, number] | null>(null)
  // As addImageStamp: the longest side is 200 pt (small images are scaled up too), at least 8 pt.
  const k = natural ? 200 / Math.max(natural[0], natural[1]) : 0
  const w = natural ? Math.max(8, natural[0] * k) * scale : 0
  const h = natural ? Math.max(8, natural[1] * k) * scale : 0
  const pos = clampBox(at, w, h, pageW, pageH)
  return (
    <img
      data-testid="place-ghost"
      data-ghost="image-stamp"
      src={url}
      alt=""
      aria-hidden="true"
      draggable={false}
      onLoad={(e) => setNatural([e.currentTarget.naturalWidth || 1, e.currentTarget.naturalHeight || 1])}
      className="pointer-events-none absolute"
      style={natural ? { ...pos, width: w, height: h, opacity: GHOST_OPACITY } : { visibility: 'hidden', position: 'absolute' }}
    />
  )
}

export function StampGhost(props: { at: Pt; scale: number; pageW: number; pageH: number }): JSX.Element | null {
  const o = useMarkup((s) => s.options.stamp)
  if (o.useCustom && o.custom) return <ImageStampGhost stamp={o.custom} {...props} />
  const def = stampByName(o.name)
  return def ? <BuiltInStampGhost def={def} {...props} /> : null
}

export function NoteGhost({ at, scale, pageW, pageH }: { at: Pt; scale: number; pageW: number; pageH: number }): JSX.Element {
  const o = useMarkup((s) => s.options.note)
  const s = NOTE_SIZE * scale
  const pos = clampBox(at, s, s, pageW, pageH)
  // The note icon as buildNote draws it (y flipped: the PDF path is y-up in a 24 pt box).
  const k = scale
  return (
    <svg data-testid="place-ghost" data-ghost="note" className="pointer-events-none absolute" style={{ ...pos, width: s, height: s, opacity: GHOST_OPACITY }} viewBox={`0 0 ${s} ${s}`} aria-hidden="true">
      <g transform={`translate(0 ${s}) scale(${k} ${-k})`} stroke="rgb(51 51 51)" strokeLinejoin="round">
        {o.icon === 'Comment' ? (
          <>
            <path d="M2 8 L6 8 L6 3 L12 8 L22 8 L22 22 L2 22 Z" fill={o.color} strokeWidth={0.8} />
            <path d="M5.5 17.5 L18.5 17.5 M5.5 13 L15 13" strokeWidth={0.9} />
          </>
        ) : (
          <>
            <rect x={2} y={2} width={20} height={20} fill={o.color} strokeWidth={0.8} />
            <path d="M5.5 17 L18.5 17 M5.5 12.5 L18.5 12.5 M5.5 8 L13 8" strokeWidth={0.9} />
          </>
        )}
      </g>
    </svg>
  )
}

/** A click with the Text box tool makes a 200 × 48 pt box whose top-left corner is the click. */
export function TextBoxGhost({ at, scale }: { at: Pt; scale: number }): JSX.Element {
  return (
    <div
      data-testid="place-ghost"
      data-ghost="textbox"
      aria-hidden="true"
      className="pointer-events-none absolute border border-dashed border-accent"
      style={{ left: at[0], top: at[1], width: 200 * scale, height: 48 * scale, opacity: 0.8 }}
    />
  )
}
