import { useWorkspace } from '../../state/workspace'
import { errorMessage, notify } from '../../state/notify'
import { AnnotProperties, CheckField, ColorField, NumberField, RangeField } from './Controls'
import { useDocAnnots } from './data'
import { IconComments } from './icons'
import { STAMPS, stampLabel } from './pdf/stamps'
import { useMarkup, type CustomStamp, type TextMarkupKind } from './store'

/** Ribbon controls shown while a markup tool is active. */

export const COMMENTS_PANEL = 'markup.comments'

export function CommentsToggle(): JSX.Element {
  const open = useWorkspace((s) => s.rightPanel === COMMENTS_PANEL)
  return (
    <button type="button" className="btn shrink-0 whitespace-nowrap text-xs" aria-pressed={open} onClick={() => useWorkspace.getState().toggleRightPanel(COMMENTS_PANEL)}>
      <IconComments />
      Comments
    </button>
  )
}

const pct = (v: number): string => `${Math.round(v * 100)}%`

export function TextMarkupOptions({ kind }: { kind: TextMarkupKind }): JSX.Element {
  const o = useMarkup((s) => s.options.textMarkup[kind])
  const patch = useMarkup((s) => s.patchTextMarkup)
  return (
    <>
      <span className="shrink-0 whitespace-nowrap text-xs text-ink-muted">Select text</span>
      <ColorField label="Color" value={o.color} onChange={(color) => patch(kind, { color })} />
      <RangeField label="Opacity" value={o.opacity} min={0.1} max={1} step={0.1} format={pct} onChange={(opacity) => patch(kind, { opacity })} />
      <CommentsToggle />
    </>
  )
}
export const HighlightOptions = (): JSX.Element => <TextMarkupOptions kind="highlight" />
export const UnderlineOptions = (): JSX.Element => <TextMarkupOptions kind="underline" />
export const StrikeoutOptions = (): JSX.Element => <TextMarkupOptions kind="strikeout" />
export const SquigglyOptions = (): JSX.Element => <TextMarkupOptions kind="squiggly" />

export function NoteOptions(): JSX.Element {
  const o = useMarkup((s) => s.options.note)
  const patch = useMarkup((s) => s.patchOptions)
  return (
    <>
      <span className="shrink-0 whitespace-nowrap text-xs text-ink-muted">Click page or press Enter</span>
      <ColorField label="Color" value={o.color} onChange={(color) => patch('note', { color })} />
      <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-ink">
        <span>Icon</span>
        <select className="field" value={o.icon} onChange={(e) => patch('note', { icon: e.target.value as 'Note' | 'Comment' })}>
          <option value="Note">Note</option>
          <option value="Comment">Comment</option>
        </select>
      </label>
      <CommentsToggle />
    </>
  )
}

/** Off: a shape, stamp or text box is selected once placed, ready to move and restyle. On: stay on the tool. */
function KeepToolField(): JSX.Element {
  const on = useMarkup((s) => s.keepTool)
  return <CheckField label="Keep tool selected" checked={on} onChange={(v) => useMarkup.getState().setKeepTool(v)} />
}

export function TextBoxOptions(): JSX.Element {
  const o = useMarkup((s) => s.options.textbox)
  const patch = useMarkup((s) => s.patchOptions)
  return (
    <>
      <span className="shrink-0 whitespace-nowrap text-xs text-ink-muted">Drag on page</span>
      <ColorField label="Text" value={o.color} onChange={(color) => patch('textbox', { color })} />
      <NumberField label="Size" value={o.size} min={6} max={72} onChange={(size) => patch('textbox', { size })} />
      <CheckField label="Fill" checked={!!o.fill} onChange={(on) => patch('textbox', { fill: on ? '#fff8b0' : null })} />
      {o.fill && <ColorField label="Fill color" value={o.fill} onChange={(fill) => patch('textbox', { fill })} />}
      <NumberField label="Border" value={o.border} min={0} max={10} onChange={(border) => patch('textbox', { border })} />
      <KeepToolField />
      <CommentsToggle />
    </>
  )
}

export function InkOptions(): JSX.Element {
  const o = useMarkup((s) => s.options.ink)
  const patch = useMarkup((s) => s.patchOptions)
  return (
    <>
      <span className="shrink-0 whitespace-nowrap text-xs text-ink-muted">Draw on page</span>
      <ColorField label="Color" value={o.color} onChange={(color) => patch('ink', { color })} />
      <NumberField label="Width" value={o.width} min={1} max={30} onChange={(width) => patch('ink', { width })} />
      <RangeField label="Opacity" value={o.opacity} min={0.1} max={1} step={0.1} format={pct} onChange={(opacity) => patch('ink', { opacity })} />
      <RangeField label="Smoothing" value={o.smoothing} min={0} max={1} step={0.1} format={pct} onChange={(smoothing) => patch('ink', { smoothing })} />
      <CommentsToggle />
    </>
  )
}

export function ShapeOptions({ fillable }: { fillable: boolean }): JSX.Element {
  const o = useMarkup((s) => s.options.shape)
  const patch = useMarkup((s) => s.patchOptions)
  return (
    <>
      <span className="shrink-0 whitespace-nowrap text-xs text-ink-muted">Drag on page</span>
      <ColorField label="Color" value={o.color} onChange={(color) => patch('shape', { color })} />
      {fillable && (
        <>
          <CheckField label="Fill" checked={!!o.fill} onChange={(on) => patch('shape', { fill: on ? '#ffe100' : null })} />
          {o.fill && <ColorField label="Fill color" value={o.fill} onChange={(fill) => patch('shape', { fill })} />}
        </>
      )}
      <NumberField label="Width" value={o.width} min={1} max={30} onChange={(width) => patch('shape', { width })} />
      <RangeField label="Opacity" value={o.opacity} min={0.1} max={1} step={0.1} format={pct} onChange={(opacity) => patch('shape', { opacity })} />
      <CheckField label="Dashed" checked={o.dashed} onChange={(dashed) => patch('shape', { dashed })} />
      <KeepToolField />
      <CommentsToggle />
    </>
  )
}
export const FilledShapeOptions = (): JSX.Element => <ShapeOptions fillable />
export const LineShapeOptions = (): JSX.Element => <ShapeOptions fillable={false} />

export function StampOptions(): JSX.Element {
  const o = useMarkup((s) => s.options.stamp)
  const patch = useMarkup((s) => s.patchOptions)
  const choose = async (): Promise<void> => {
    try {
      // The renderer never supplies a path: main shows the native dialog and returns the file's bytes.
      const picked = await window.epdf.call<(Omit<CustomStamp, 'bytes'> & { bytes: Uint8Array }) | null>('markup:pickImage', {})
      if (picked) patch('stamp', { custom: { name: picked.name, kind: picked.kind, bytes: picked.bytes }, useCustom: true })
    } catch (err) {
      notify('error', `Couldn’t use that image: ${errorMessage(err)}`)
    }
  }
  return (
    <>
      <span className="shrink-0 whitespace-nowrap text-xs text-ink-muted">Click page or press Enter</span>
      <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-ink">
        <span>Stamp</span>
        <select
          className="field"
          value={o.useCustom && o.custom ? '__custom' : o.name}
          onChange={(e) => (e.target.value === '__custom' ? patch('stamp', { useCustom: true }) : patch('stamp', { name: e.target.value, useCustom: false }))}
        >
          {STAMPS.map((s) => (
            <option key={s.name} value={s.name}>
              {stampLabel(s.name)}
            </option>
          ))}
          {o.custom && <option value="__custom">Image: {o.custom.name}</option>}
        </select>
      </label>
      <button type="button" className="btn shrink-0 whitespace-nowrap text-xs" onClick={() => void choose()}>
        Choose image…
      </button>
      <KeepToolField />
      <CommentsToggle />
    </>
  )
}

export function SelectOptions({ docId }: { docId: string }): JSX.Element {
  const selection = useMarkup((s) => s.selection)
  const data = useDocAnnots(docId, true)
  const annot = selection?.docId === docId ? data?.annots.find((a) => a.id === selection.id) : undefined
  return (
    <>
      {annot ? <AnnotProperties docId={docId} annot={annot} variant="ribbon" /> : <span className="shrink-0 whitespace-nowrap text-xs text-ink-muted">Click an annotation</span>}
      <CommentsToggle />
    </>
  )
}
