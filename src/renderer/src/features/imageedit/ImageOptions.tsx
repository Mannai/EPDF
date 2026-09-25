import { useEffect, useState } from 'react'
import { applyImageBox, describePicked, pickImage, removeImage, replaceSelected } from './actions'
import { cancelPlacement } from './ImageOverlay'
import { useImageEdit } from './state'

const r2 = (n: number): string => String(Math.round(n * 100) / 100)

/** Ribbon controls for the "Edit images" tool: add / replace / delete and exact position and size. */
export function ImageOptions({ docId }: { docId: string }): JSX.Element {
  const selected = useImageEdit((s) => (s.selected && s.selected.docId === docId ? s.selected : null))
  const pending = useImageEdit((s) => (s.pending && s.pending.docId === docId ? s.pending : null))
  const mode = useImageEdit((s) => s.mode)
  const busy = useImageEdit((s) => s.busy)
  const [f, setF] = useState({ x: '', y: '', w: '', h: '' })
  const [keep, setKeep] = useState(true)

  useEffect(() => {
    if (!selected) return setF({ x: '', y: '', w: '', h: '' })
    setF({ x: r2(selected.bbox.x0), y: r2(selected.bbox.y0), w: r2(selected.bbox.x1 - selected.bbox.x0), h: r2(selected.bbox.y1 - selected.bbox.y0) })
  }, [selected])

  const usable = !!selected && selected.editable && !busy
  const num = (s: string): number => parseFloat(s)
  const ratio = selected ? (selected.bbox.x1 - selected.bbox.x0) / (selected.bbox.y1 - selected.bbox.y0) : 1

  const apply = (): void => {
    if (!selected) return
    const x = num(f.x)
    const y = num(f.y)
    const w = num(f.w)
    const h = num(f.h)
    if (![x, y, w, h].every(Number.isFinite)) return
    void applyImageBox(selected, { x0: x, y0: y, x1: x + w, y1: y + h })
  }

  const field = (label: string, long: string, key: 'x' | 'y' | 'w' | 'h', testId: string, disabled = false): JSX.Element => (
    <label className="flex items-center gap-1 whitespace-nowrap text-xs text-ink" title={long}>
      {label}
      <input
        type="number"
        step="any"
        aria-label={long}
        className="field h-7 w-[4.5rem] text-xs"
        value={f[key]}
        disabled={!usable || disabled}
        data-testid={testId}
        onChange={(e) => {
          const v = e.target.value
          setF((cur) => {
            const next = { ...cur, [key]: v }
            if (keep && selected?.resizable && Number.isFinite(num(v)) && ratio > 0) {
              if (key === 'w') next.h = r2(num(v) / ratio)
              if (key === 'h') next.w = r2(num(v) * ratio)
            }
            return next
          })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') apply()
        }}
      />
    </label>
  )

  return (
    <>
      <button
        type="button"
        className="btn h-7 whitespace-nowrap text-xs"
        disabled={busy}
        data-testid="imageedit-add"
        onClick={async () => {
          const p = await pickImage()
          if (!p) return
          useImageEdit.getState().setPending({ docId, picture: { kind: p.kind, bytes: p.bytes }, name: p.name, ...describePicked(p) })
        }}
      >
        Add image…
      </button>
      {pending ? (
        <>
          <button type="button" className="btn-primary h-7 whitespace-nowrap text-xs" disabled={busy} data-testid="imageedit-center" onClick={() => useImageEdit.getState().requestCenter()}>
            Place at page center
          </button>
          <button type="button" className="btn h-7 whitespace-nowrap text-xs" onClick={cancelPlacement}>
            Cancel
          </button>
          <span className="whitespace-nowrap text-xs text-ink-muted">Click the page to place “{pending.name}”.</span>
        </>
      ) : (
        <>
          <button
            type="button"
            className="btn h-7 whitespace-nowrap text-xs"
            disabled={!usable}
            data-testid="imageedit-replace"
            onClick={async () => {
              const p = await pickImage()
              if (p && selected) await replaceSelected(selected, { kind: p.kind, bytes: p.bytes })
            }}
          >
            Replace…
          </button>
          <label className="flex items-center gap-1 whitespace-nowrap text-xs text-ink">
            Replace as
            <select className="field h-7 text-xs" value={mode} aria-label="How a replacement picture fills the old box: fit inside it or fill it and crop" onChange={(e) => useImageEdit.getState().setMode(e.target.value as 'fit' | 'fill')} data-testid="imageedit-mode">
              <option value="fit">Fit</option>
              <option value="fill">Fill (crop)</option>
            </select>
          </label>
          <button type="button" className="btn h-7 whitespace-nowrap text-xs" disabled={!usable} data-testid="imageedit-delete" onClick={() => selected && void removeImage(selected)}>
            Delete
          </button>
          {field('X', 'X position in points', 'x', 'imageedit-x')}
          {field('Y', 'Y position in points, from the bottom', 'y', 'imageedit-y')}
          {field('W', 'Width in points', 'w', 'imageedit-w', !selected?.resizable)}
          {field('H', 'Height in points', 'h', 'imageedit-h', !selected?.resizable)}
          <label className="flex items-center gap-1 whitespace-nowrap text-xs text-ink" title="Keep the proportions when changing the width or height">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} disabled={!usable} />
            Keep ratio
          </label>
          <button type="button" className="btn-primary h-7 whitespace-nowrap text-xs" disabled={!usable} data-testid="imageedit-apply" onClick={apply}>
            Apply
          </button>
          {!selected && <span className="whitespace-nowrap text-xs text-ink-muted">Select an image on the page (units: points, Y from the bottom).</span>}
        </>
      )}
    </>
  )
}
