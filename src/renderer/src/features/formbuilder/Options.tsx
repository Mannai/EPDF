import { useWorkspace } from '../../state/workspace'
import { arrange, enterPreview } from './actions'
import type { AlignMode } from './logic/align'
import { useBuilder } from './store'

/** Ribbon options while a form-builder tool is active: Preview, and arranging the selected fields. */

const sel = 'field h-7 w-[8.5rem] px-1 text-xs'

export function BuilderOptions({ docId }: { docId: string }): JSX.Element {
  const selected = useBuilder((s) => (s.selectionDoc === docId ? s.selection.length : 0))
  const radioGroup = useBuilder((s) => s.radioGroup)
  const tool = useWorkspace((s) => s.activeTool)
  return (
    <>
      <button type="button" className="btn h-7 px-2 text-xs" data-testid="fb-preview-toggle" onClick={() => enterPreview(docId)}>
        Preview
      </button>
      <label className="flex items-center gap-1 text-xs">
        Align
        <select
          className={sel}
          value=""
          disabled={selected < 2}
          aria-label="Align selected fields"
          onChange={(e) => {
            const v = e.target.value as AlignMode
            if (v) void arrange(docId, { kind: 'align', mode: v })
          }}
        >
          <option value="">Choose…</option>
          <option value="left">Left edges</option>
          <option value="right">Right edges</option>
          <option value="top">Top edges</option>
          <option value="bottom">Bottom edges</option>
          <option value="hcenter">Centers horizontally</option>
          <option value="vcenter">Centers vertically</option>
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs">
        Distribute
        <select
          className={sel}
          value=""
          disabled={selected < 3}
          aria-label="Distribute selected fields"
          onChange={(e) => {
            const v = e.target.value
            if (v === 'horizontal' || v === 'vertical') void arrange(docId, { kind: 'distribute', axis: v })
          }}
        >
          <option value="">Choose…</option>
          <option value="horizontal">Horizontally</option>
          <option value="vertical">Vertically</option>
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs">
        Same size
        <select
          className={sel}
          value=""
          disabled={selected < 2}
          aria-label="Give selected fields the same size as the first"
          onChange={(e) => {
            const v = e.target.value
            if (v === 'width' || v === 'height' || v === 'both') void arrange(docId, { kind: 'size', dim: v })
          }}
        >
          <option value="">Choose…</option>
          <option value="width">Same width</option>
          <option value="height">Same height</option>
          <option value="both">Same size</option>
        </select>
      </label>
      {tool === 'formbuilder.radio' && (
        <span className="flex items-center gap-1 text-xs">
          <span data-testid="fb-radio-group">{radioGroup ? `Adding to “${radioGroup}”` : 'Next button starts a new group'}</span>
          <button type="button" className="btn h-7 px-2 text-xs" disabled={!radioGroup} onClick={() => useBuilder.getState().setRadioGroup(null)}>
            New group
          </button>
        </span>
      )}
    </>
  )
}
