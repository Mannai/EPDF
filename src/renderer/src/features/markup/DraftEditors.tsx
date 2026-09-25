import { useEffect, useRef, useState } from 'react'
import { createNote, createTextBox } from './actions'
import { hexToRgb } from './pdf/basics'
import { pdfRectToView, pdfToView, type PageGeom } from './pdf/geometry'
import { useMarkup, type Draft } from './store'

/**
 * Editors for annotations that need typing before they exist. Nothing is written to the document until
 * the text is committed, so typing never creates undo steps.
 */

type NoteDraft = Extract<Draft, { kind: 'note' }>
type BoxDraft = Extract<Draft, { kind: 'textbox' }>

export function NoteDraftEditor({ draft, scale, geom, width, height }: { draft: NoteDraft; scale: number; geom: PageGeom; width: number; height: number }): JSX.Element {
  const [text, setText] = useState('')
  const busy = useRef(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])

  const [px, py] = pdfToView(geom, draft.at[0], draft.at[1])
  const cardW = 256
  const left = Math.min(Math.max(4, px * scale + 16), Math.max(4, width - cardW - 4))
  const top = Math.min(Math.max(4, py * scale - 12), Math.max(4, height - 160))

  const cancel = (): void => useMarkup.getState().setDraft(null)
  const submit = async (): Promise<void> => {
    if (busy.current) return
    busy.current = true
    const id = await createNote(draft.docId, draft.pageIndex, draft.at, text.trim())
    busy.current = false
    useMarkup.getState().setDraft(null)
    if (id) useMarkup.getState().select(draft.docId, id)
  }

  return (
    <form
      role="dialog"
      aria-label="New sticky note"
      data-testid="note-draft"
      className="pointer-events-auto absolute z-10 w-64 rounded-md border border-line bg-raised p-2 text-ink shadow-lg"
      style={{ left, top }}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          cancel()
        }
      }}
    >
      <label htmlFor="note-draft-text" className="mb-1 block text-xs font-medium text-ink-muted">
        Note text
      </label>
      <textarea
        id="note-draft-text"
        ref={ref}
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void submit()
          }
        }}
        className="field h-auto w-full resize-y py-1"
      />
      <p className="mt-1 text-xs text-ink-muted">Enter adds the note, Shift+Enter starts a new line, Escape cancels.</p>
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" className="btn" onClick={cancel}>
          Cancel
        </button>
        <button type="submit" className="btn-primary">
          Add note
        </button>
      </div>
    </form>
  )
}

export function TextBoxDraftEditor({ draft, scale, geom }: { draft: BoxDraft; scale: number; geom: PageGeom }): JSX.Element {
  const o = useMarkup((s) => s.options.textbox)
  const [text, setText] = useState('')
  const busy = useRef(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)
  useEffect(() => ref.current?.focus(), [])
  const r = pdfRectToView(geom, draft.rect).map((v) => v * scale)
  const [cr, cg, cb] = hexToRgb(o.color).map((v) => Math.round(v * 255))

  const finish = async (commit: boolean): Promise<void> => {
    if (done.current || busy.current) return
    done.current = true
    busy.current = true
    if (commit && text.trim()) await createTextBox(draft.docId, draft.pageIndex, draft.rect, text)
    busy.current = false
    useMarkup.getState().setDraft(null)
  }

  return (
    <textarea
      ref={ref}
      aria-label="Text box text"
      data-testid="textbox-draft"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => void finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          void finish(false)
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          void finish(true)
        }
      }}
      className="pointer-events-auto absolute resize-none border border-dashed border-accent p-0.5 outline-none focus:ring-2 focus:ring-accent"
      style={{
        left: r[0],
        top: r[1],
        width: r[2] - r[0],
        height: r[3] - r[1],
        fontSize: o.size * scale,
        lineHeight: 1.2,
        fontFamily: 'Helvetica, Arial, sans-serif',
        color: `rgb(${cr} ${cg} ${cb})`,
        // The page is white paper in both themes, so the editor is too (it previews PDF content).
        background: o.fill ? o.fill : '#ffffff'
      }}
    />
  )
}
