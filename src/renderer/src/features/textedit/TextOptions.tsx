import { cancelTextEdit, commitTextEdit } from './commit'
import { useTextEdit, type Scope } from './state'

/** Extra ribbon controls for the "Edit text" tool: scope, font size, color, apply/cancel. */
export function TextOptions({ docId }: { docId: string }): JSX.Element {
  const scope = useTextEdit((s) => s.scope)
  const editing = useTextEdit((s) => (s.editing && s.editing.docId === docId ? s.editing : null))
  const busy = useTextEdit((s) => s.busy)
  const setScope = useTextEdit((s) => s.setScope)
  const patch = useTextEdit((s) => s.patch)

  return (
    <>
      <span id="textedit-hint" className="sr-only">
        Type to change the text. Enter applies the change, Shift+Enter starts a new line, Escape cancels.
      </span>
      <label className="flex items-center gap-1.5 text-xs text-ink">
        Edit
        <select
          className="field h-7 text-xs"
          value={scope}
          onChange={(e) => setScope(e.target.value as Scope)}
          aria-label="Edit scope"
          data-testid="textedit-scope"
        >
          <option value="line">Line</option>
          <option value="paragraph">Paragraph</option>
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-xs text-ink">
        Font size
        <input
          type="number"
          className="field h-7 w-16 text-xs"
          min={1}
          max={400}
          step={0.5}
          disabled={!editing || busy}
          value={editing ? editing.size : ''}
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            if (Number.isFinite(v) && v > 0) patch({ size: v })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitTextEdit()
          }}
          data-testid="textedit-size"
        />
      </label>
      <label className="flex items-center gap-1.5 text-xs text-ink">
        Color
        <input
          type="color"
          className="h-7 w-9 cursor-pointer rounded border border-line bg-surface p-0.5 disabled:opacity-40"
          disabled={!editing || busy}
          value={editing ? editing.color : '#000000'}
          onChange={(e) => patch({ color: e.target.value })}
          data-testid="textedit-color"
        />
      </label>
      {editing ? (
        <>
          <button type="button" className="btn-primary h-7 text-xs" disabled={busy} onClick={() => void commitTextEdit()} data-testid="textedit-apply">
            Apply
          </button>
          <button type="button" className="btn h-7 text-xs" disabled={busy} onClick={cancelTextEdit} data-testid="textedit-cancel">
            Cancel
          </button>
        </>
      ) : (
        <span className="text-xs text-ink-muted">Click text on the page to edit it.</span>
      )}
    </>
  )
}
