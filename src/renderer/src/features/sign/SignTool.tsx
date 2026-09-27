import type { SignatureKind } from '@shared/features/sign'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { create } from 'zustand'
import { degrees } from 'pdf-lib'
import { editPdf } from '../../edit/session'
import { errorMessage, notify } from '../../state/notify'
import { useUi } from '../../state/ui'
import { useWorkspace } from '../../state/workspace'
import type { PageOverlayProps } from '../api'
import { dateLabel, drawDateAt } from '../forms/draw'
import { loadUnicodeFont } from '../forms/fontClient'
import { PageGeometry, geometryOf, normalizeRotation, type Matrix } from '../forms/geometry'
import { isolateViewerKeys } from '../forms/keys'
import { VISUAL_SIGNATURE_NOTICE } from './SignatureDialog'
import { selectedItem, useSignatures, type SignatureItem } from './store'

/**
 * The Sign / Initials tools: pick a saved signature, click a page, drag / resize / nudge it, then place it.
 * Placing embeds the PNG (with its alpha channel) into the page content through `editPdf` = one undo step.
 */

export const SIGN_TOOL_IDS = { signature: 'sign.signature', initials: 'sign.initials' } as const

const kindOfTool = (tool: string | null): SignatureKind | null => (tool === SIGN_TOOL_IDS.signature ? 'signature' : tool === SIGN_TOOL_IDS.initials ? 'initials' : null)

/** Default width in points of a freshly placed signature / initials. */
const DEFAULT_WIDTH: Record<SignatureKind, number> = { signature: 150, initials: 60 }
const DATE_SIZE = 10
const MIN_WIDTH = 16

export interface SignDraft {
  docId: string
  pageIndex: number
  matrix: Matrix
  rotation: number
  itemId: number
  /** Points, as the reader sees the page (origin top-left, y down). Height follows the aspect ratio. */
  left: number
  top: number
  width: number
}

interface PlacementState {
  draft: SignDraft | null
  setDraft(d: SignDraft | null): void
  patch(p: Partial<SignDraft>): void
}
export const usePlacement = create<PlacementState>((set) => ({
  draft: null,
  setDraft: (draft) => set({ draft }),
  patch: (p) => set((s) => (s.draft ? { draft: { ...s.draft, ...p } } : s))
}))

export const cancelPlacement = (): void => usePlacement.getState().setDraft(null)

const heightOf = (item: Pick<SignatureItem, 'width' | 'height'>, width: number): number => (width * item.height) / item.width

/** Embeds the signature into the page at the draft's rectangle (and the date beneath it, if asked). */
export async function commitPlacement(): Promise<boolean> {
  const draft = usePlacement.getState().draft
  const item = draft && useSignatures.getState().items.find((i) => i.id === draft.itemId)
  if (!draft || !item) return false
  cancelPlacement()
  const geom = new PageGeometry(draft.matrix, normalizeRotation(draft.rotation))
  const s = geom.scaleX()
  const frame = geom.frameOfBox({ left: draft.left * s, top: draft.top * s, width: draft.width * s, height: heightOf(item, draft.width) * s })
  const label = item.kind === 'signature' ? 'Sign' : 'Add initials'
  try {
    await editPdf(draft.docId, label, async (pdf) => {
      if (draft.pageIndex >= pdf.getPageCount()) throw new Error('That page no longer exists.')
      const page = pdf.getPage(draft.pageIndex)
      const img = await pdf.embedPng(item.png)
      page.drawImage(img, { x: frame.origin[0], y: frame.origin[1], width: frame.width, height: frame.height, rotate: degrees(frame.rotation) })
      if (useSignatures.getState().withDate) {
        await drawDateAt(pdf, draft.pageIndex, frame, 0, -DATE_SIZE * 1.05, DATE_SIZE, '#000000', loadUnicodeFont, dateLabel())
      }
    })
    useUi.getState().announce(`${item.kind === 'signature' ? 'Signature' : 'Initials'} placed on page ${draft.pageIndex + 1}`)
    return true
  } catch (err) {
    notify('error', errorMessage(err))
    return false
  }
}

/** Ribbon controls for the Sign / Initials tools. */
export function SignOptions({ kind }: { kind: SignatureKind }): JSX.Element {
  const all = useSignatures((s) => s.items)
  const items = useMemo(() => all.filter((i) => i.kind === kind), [all, kind])
  const selected = useSignatures((s) => s.selected[kind])
  const encryption = useSignatures((s) => s.encryptionAvailable)
  const withDate = useSignatures((s) => s.withDate)
  const loaded = useSignatures((s) => s.loaded)

  useEffect(() => {
    if (!loaded) void useSignatures.getState().refresh().catch(() => undefined)
  }, [loaded])

  const noun = kind === 'signature' ? 'signature' : 'initials'
  return (
    <>
      {items.length > 0 ? (
        <label className="flex items-center gap-1 text-xs">
          {kind === 'signature' ? 'Signature' : 'Initials'}
          <select className="field h-7 max-w-[10rem] px-1" aria-label={kind === 'signature' ? 'Signature to place' : 'Initials to place'} value={selected ?? ''} onChange={(e) => useSignatures.getState().select(kind, Number(e.target.value))}>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <span className="text-xs text-ink-muted">{loaded ? `No saved ${noun} yet.` : 'Loading…'}</span>
      )}
      <button type="button" className="btn h-7 px-2 text-xs" onClick={() => useSignatures.getState().openDialog(kind)}>
        {items.length > 0 ? 'Manage…' : `Create ${noun}…`}
      </button>
      <label className="flex items-center gap-1 text-xs">
        <input type="checkbox" checked={withDate} onChange={(e) => useSignatures.getState().setWithDate(e.target.checked)} />
        Add date
      </label>
      <span className="max-w-[16rem] text-[11px] leading-tight text-ink-muted" title={VISUAL_SIGNATURE_NOTICE}>
        Visual signature only. Not a digital certificate signature.
      </span>
      {encryption === false && (
        <span role="alert" className="text-xs text-danger">
          Secure storage unavailable
        </span>
      )}
    </>
  )
}

function Draft({ docId, pageIndex, viewport, scale }: PageOverlayProps): JSX.Element | null {
  const draft = usePlacement((s) => s.draft)
  const item = useSignatures((s) => (draft ? s.items.find((i) => i.id === draft.itemId) : undefined))
  const withDate = useSignatures((s) => s.withDate)
  const boxRef = useRef<HTMLDivElement>(null)
  const drag = useRef<null | { kind: 'move' | 'resize'; x: number; y: number; left: number; top: number; width: number }>(null)
  const mine = !!draft && draft.docId === docId && draft.pageIndex === pageIndex

  useEffect(() => {
    if (mine && viewport) {
      const g = geometryOf(viewport)
      usePlacement.getState().patch({ matrix: g.matrix, rotation: g.rotation })
    }
  }, [mine, viewport])
  useEffect(() => {
    if (mine) boxRef.current?.focus()
  }, [mine])

  if (!mine || !draft || !item) return null
  const patch = usePlacement.getState().patch
  const h = heightOf(item, draft.width)

  const start = (kind: 'move' | 'resize') => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { kind, x: e.clientX, y: e.clientY, left: draft.left, top: draft.top, width: draft.width }
    boxRef.current?.focus()
  }
  const move = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.x) / scale
    const dy = (e.clientY - d.y) / scale
    if (d.kind === 'move') patch({ left: d.left + dx, top: d.top + dy })
    else patch({ width: Math.max(MIN_WIDTH, d.width + dx) }) // aspect ratio is kept: the height follows
  }
  const end = (e: ReactPointerEvent<HTMLElement>): void => {
    drag.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    isolateViewerKeys(e) // the viewer would otherwise turn the arrow keys into page navigation
    const step = e.shiftKey ? 10 : 1
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    if (e.key in moves) {
      e.preventDefault()
      const [dx, dy] = moves[e.key]
      patch({ left: draft.left + dx, top: draft.top + dy })
    } else if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
      e.preventDefault()
      const f = e.key === '+' || e.key === '=' ? 1.08 : 1 / 1.08
      patch({ width: Math.max(MIN_WIDTH, draft.width * f) })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void commitPlacement()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cancelPlacement()
    }
  }

  return (
    <div
      ref={boxRef}
      role="group"
      tabIndex={0}
      aria-label={`Placing ${item.kind === 'signature' ? 'signature' : 'initials'} “${item.name}”. Arrow keys move it (Shift for bigger steps), plus and minus resize it, Enter places it, Escape cancels.`}
      data-testid="signature-draft"
      className="pointer-events-auto absolute cursor-move outline outline-2 outline-dashed outline-accent focus-visible:outline-solid"
      style={{ left: draft.left * scale, top: draft.top * scale, width: draft.width * scale, height: h * scale }}
      onPointerDown={start('move')}
      onPointerMove={move}
      onPointerUp={end}
      onKeyDown={onKeyDown}
    >
      <img src={item.url} alt="" draggable={false} className="h-full w-full select-none" />
      {withDate && (
        <span className="pointer-events-none absolute left-0 whitespace-nowrap text-black" style={{ top: h * scale + 2, fontSize: DATE_SIZE * scale, lineHeight: 1.05, fontFamily: 'Arial, Helvetica, sans-serif' }}>
          {dateLabel()}
        </span>
      )}
      <div
        role="presentation"
        className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border border-accent bg-accent"
        data-testid="signature-resize"
        onPointerDown={start('resize')}
        onPointerMove={move}
        onPointerUp={end}
      />
      <div className="absolute left-0 flex gap-1" style={{ top: h * scale + (withDate ? DATE_SIZE * scale * 1.4 : 0) + 10 }} onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" className="btn-primary h-7 px-2 text-xs" onClick={() => void commitPlacement()}>
          Place {item.kind === 'signature' ? 'signature' : 'initials'}
        </button>
        <button type="button" className="btn h-7 px-2 text-xs" onClick={cancelPlacement}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/** Click-to-place layer for the Sign / Initials tools plus the draggable placement box. */
export function SignOverlay(props: PageOverlayProps): JSX.Element | null {
  const tool = useWorkspace((s) => s.activeTool)
  const kind = kindOfTool(tool)
  const [hover, setHover] = useState<[number, number] | null>(null)
  const placing = usePlacement((s) => s.draft !== null)
  // The signature a click would place, shown see-through under the pointer at its real size.
  const item = useSignatures((s) => (kind ? selectedItem(s, kind) : undefined))
  useEffect(() => setHover(null), [tool])
  const { docId, pageIndex, viewport, scale } = props
  if (!kind || !viewport) return null
  const ghostW = DEFAULT_WIDTH[kind] * scale
  const ghostH = item ? heightOf(item, DEFAULT_WIDTH[kind]) * scale : 0

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const st = useSignatures.getState()
    const item = selectedItem(st, kind)
    if (!item) {
      notify('info', `Create a ${kind === 'signature' ? 'signature' : 'set of initials'} first.`)
      st.openDialog(kind)
      return
    }
    const box = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - box.left) / scale
    const y = (e.clientY - box.top) / scale
    const g = geometryOf(viewport)
    const width = DEFAULT_WIDTH[kind]
    const height = heightOf(item, width)
    // Center the box on the click.
    usePlacement.getState().setDraft({
      docId,
      pageIndex,
      matrix: g.matrix,
      rotation: g.rotation,
      itemId: item.id,
      left: x - width / 2,
      top: y - height / 2,
      width
    })
  }

  return (
    <>
      <div
        className="pointer-events-auto absolute inset-0"
        style={{ cursor: 'crosshair' }}
        data-testid="sign-layer"
        onPointerDown={onPointerDown}
        onPointerMove={(e) => {
          if (e.pointerType === 'touch') return
          const b = e.currentTarget.getBoundingClientRect()
          setHover([e.clientX - b.left, e.clientY - b.top])
        }}
        onPointerLeave={() => setHover(null)}
      />
      {hover && item && !placing && (
        <img
          data-testid="place-ghost"
          data-ghost={kind}
          src={item.url}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="pointer-events-none absolute outline outline-1 outline-dashed outline-accent"
          style={{ left: hover[0] - ghostW / 2, top: hover[1] - ghostH / 2, width: ghostW, height: ghostH, opacity: 0.55 }}
        />
      )}
      <Draft {...props} />
    </>
  )
}
