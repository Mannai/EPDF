import type { SignatureKind } from '@shared/features/sign'
import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { notify } from '../../state/notify'
import { useWorkspace } from '../../state/workspace'
import type { PageOverlayProps } from '../api'
import { dateLabel } from '../forms/draw'
import { geometryOf } from '../forms/geometry'
import { createFillSignature, selectPlaced } from '../markup/actions'
import { KeepToolField } from '../markup/Options'
import { VISUAL_SIGNATURE_NOTICE } from './SignatureDialog'
import { selectedItem, useSignatures, type SignatureItem } from './store'

/**
 * The Sign / Initials tools: pick a saved signature and click the page. It lands centred on the click as a Fill & sign
 * item (an image stamp annotation, one undo step) and is selected with the Select tool, so it can be moved, resized or
 * deleted straight away; clicking elsewhere confirms it. Saving offers to lock it into the page.
 */

export const SIGN_TOOL_IDS = { signature: 'sign.signature', initials: 'sign.initials' } as const

const kindOfTool = (tool: string | null): SignatureKind | null => (tool === SIGN_TOOL_IDS.signature ? 'signature' : tool === SIGN_TOOL_IDS.initials ? 'initials' : null)

/** Default width in points of a freshly placed signature / initials. */
const DEFAULT_WIDTH: Record<SignatureKind, number> = { signature: 150, initials: 60 }
const DATE_SIZE = 10

const heightOf = (item: Pick<SignatureItem, 'width' | 'height'>, width: number): number => (width * item.height) / item.width

/** Places the signature centred on `center` (PDF user space), with today's date under it if asked, then selects it. */
export async function placeSignature(docId: string, pageIndex: number, item: SignatureItem, center: [number, number]): Promise<void> {
  const date = useSignatures.getState().withDate ? { text: dateLabel(), size: DATE_SIZE } : undefined
  const id = await createFillSignature(docId, pageIndex, { png: item.png, center, width: DEFAULT_WIDTH[item.kind], initials: item.kind === 'initials', date })
  selectPlaced(docId, id)
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
      <KeepToolField />
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

/** Click-to-place layer for the Sign / Initials tools, with a see-through preview of the signature under the pointer. */
export function SignOverlay(props: PageOverlayProps): JSX.Element | null {
  const tool = useWorkspace((s) => s.activeTool)
  const kind = kindOfTool(tool)
  const [hover, setHover] = useState<[number, number] | null>(null)
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
    const chosen = selectedItem(st, kind)
    if (!chosen) {
      notify('info', `Create a ${kind === 'signature' ? 'signature' : 'set of initials'} first.`)
      st.openDialog(kind)
      return
    }
    const box = e.currentTarget.getBoundingClientRect()
    setHover(null)
    void placeSignature(docId, pageIndex, chosen, geometryOf(viewport).toPdf(e.clientX - box.left, e.clientY - box.top))
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
      {hover && item && (
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
    </>
  )
}
