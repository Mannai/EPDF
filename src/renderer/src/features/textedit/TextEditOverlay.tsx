import type { PageViewport } from 'pdfjs-dist'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditInfo } from '../../edit/session'
import { notify } from '../../state/notify'
import { useWorkspace } from '../../state/workspace'
import type { PageOverlayProps } from '../api'
import { cancelTextEdit, commitTextEdit } from './commit'
import { loadPageContent, type PageContentResult } from './pageContent'
import type { TextBlock } from './pdfcontent/blocks'
import { cssFontFamily } from './pdfcontent/fonts'
import type { Rect } from './pdfcontent/matrix'
import { useTextEdit, type TextEditing } from './state'

export const TEXT_TOOL_ID = 'edit-text'

interface Box {
  left: number
  top: number
  width: number
  height: number
}

const toBox = (viewport: PageViewport, r: Rect): Box => {
  const [ax, ay] = viewport.convertToViewportPoint(r.x0, r.y0)
  const [bx, by] = viewport.convertToViewportPoint(r.x1, r.y1)
  return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) }
}

const preview = (t: string): string => {
  const s = t.replace(/\s+/g, ' ').trim()
  return s.length > 70 ? `${s.slice(0, 67)}…` : s
}

function beginEditing(docId: string, pageIndex: number, b: TextBlock): void {
  if (!b.editable) {
    notify('info', `This text can’t be edited: ${b.reason}.`)
    return
  }
  const first = b.lines[0]
  useTextEdit.getState().begin({
    docId,
    pageIndex,
    blockId: b.id,
    level: b.level,
    oldText: b.text,
    text: b.text,
    size: Math.round(b.size * 100) / 100,
    origSize: Math.round(b.size * 100) / 100,
    color: b.color.css,
    origColor: b.color.css,
    fontFamily: cssFontFamily(b.font),
    bold: b.font.style.bold,
    italic: b.font.style.italic,
    bbox: b.bbox,
    firstLine: first.bbox,
    leading: b.leading,
    lineCount: b.lines.length
  })
}

/** Draws the editable text blocks of every page while the "Edit text" tool is active. */
export function TextEditOverlay(props: PageOverlayProps): JSX.Element | null {
  const active = useWorkspace((s) => s.activeTool === TEXT_TOOL_ID)
  if (!active || !props.viewport) return null
  return <Layer {...props} viewport={props.viewport} />
}

function Layer({ docId, pageIndex, scale, viewport }: PageOverlayProps & { viewport: PageViewport }): JSX.Element {
  const version = useEditInfo(docId).version
  const scope = useTextEdit((s) => s.scope)
  const editing = useTextEdit((s) => (s.editing && s.editing.docId === docId && s.editing.pageIndex === pageIndex ? s.editing : null))
  const [res, setRes] = useState<PageContentResult | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadPageContent(docId, pageIndex).then((r) => {
      if (!cancelled) setRes(r)
    })
    return () => {
      cancelled = true
    }
  }, [docId, pageIndex, version])

  const blocks = useMemo(() => {
    if (!res?.ok) return []
    const set = res.content.blocks
    if (scope === 'line') return set.lines
    const covered = new Set(set.paragraphs.flatMap((p) => p.runs.map((r) => r.id)))
    return [...set.paragraphs, ...set.lines.filter((l) => !covered.has(l.runs[0].id))]
  }, [res, scope])

  let banner: string | null = null
  if (res && !res.ok) banner = res.message
  else if (res?.ok && res.content.blocks.lines.length === 0) {
    banner =
      res.content.analysis.hiddenRuns > 0
        ? 'This page only has an invisible text layer (probably a scanned image with OCR), so there is no visible text to edit.'
        : 'No editable text on this page. It may be a scanned image, or its text may be drawn as shapes.'
  }

  return (
    <>
      <div
        className="pointer-events-auto absolute inset-0"
        data-testid="textedit-layer"
        onMouseDown={() => {
          if (banner && !useTextEdit.getState().editing) notify('info', banner)
        }}
      />
      {blocks.map((b) => {
        if (editing && editing.blockId === b.id) return null
        const r = toBox(viewport, b.bbox)
        return (
          <div
            key={b.id}
            role="button"
            tabIndex={0}
            data-block={b.id}
            data-editable={b.editable}
            aria-label={`${b.editable ? 'Edit' : 'Can’t edit'} ${b.level === 'paragraph' ? 'paragraph' : 'text'}: ${preview(b.text)}`}
            title={b.editable ? undefined : `Can’t be edited: ${b.reason}`}
            className={`pointer-events-auto absolute rounded-sm outline-1 outline-offset-0 hover:bg-accent/10 hover:outline focus-visible:outline-2 focus-visible:outline-accent ${
              b.editable ? 'cursor-text outline-accent' : 'cursor-not-allowed outline-dashed outline-ink-muted'
            }`}
            style={{ left: r.left - 1, top: r.top - 1, width: r.width + 2, height: r.height + 2 }}
            onClick={() => beginEditing(docId, pageIndex, b)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                beginEditing(docId, pageIndex, b)
              }
            }}
          />
        )
      })}
      {editing && <Editor ed={editing} viewport={viewport} scale={scale} />}
      {banner && (
        <div
          role="status"
          data-testid="textedit-banner"
          className="pointer-events-none absolute left-1/2 top-3 max-w-[90%] -translate-x-1/2 rounded-md border border-line bg-raised px-3 py-1.5 text-center text-xs text-ink shadow"
        >
          {banner}
        </div>
      )}
    </>
  )
}

function Editor({ ed, viewport, scale }: { ed: TextEditing; viewport: PageViewport; scale: number }): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  const box = toBox(viewport, ed.bbox)
  const first = toBox(viewport, ed.firstLine)
  const fontPx = ed.size * scale
  const lineH = (ed.leading > 0 ? ed.leading * (ed.size / ed.origSize) : ed.size * 1.2) * scale
  const rows = ed.text.split('\n').length

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const style: React.CSSProperties & { fieldSizing?: string } = {
    position: 'absolute',
    left: box.left - 3,
    top: first.top + first.height / 2 - lineH / 2 - 1,
    minWidth: box.width + 8,
    width: 'max-content',
    fontFamily: ed.fontFamily,
    fontSize: fontPx,
    lineHeight: `${lineH}px`,
    fontWeight: ed.bold ? 700 : 400,
    fontStyle: ed.italic ? 'italic' : 'normal',
    color: ed.color,
    background: '#ffffff',
    outline: '2px solid rgb(var(--c-accent))',
    padding: '1px 2px',
    margin: 0,
    border: 0,
    resize: 'none',
    overflow: 'hidden',
    whiteSpace: 'pre',
    userSelect: 'text',
    fieldSizing: 'content'
  }

  return (
    <textarea
      ref={ref}
      data-testid="textedit-editor"
      aria-label="Edit text on the page"
      aria-describedby="textedit-hint"
      className="pointer-events-auto"
      rows={rows}
      wrap="off"
      spellCheck={false}
      value={ed.text}
      style={style}
      onChange={(e) => useTextEdit.getState().patch({ text: e.target.value })}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          cancelTextEdit()
        } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          void commitTextEdit()
        }
      }}
      onBlur={(e) => {
        // Moving to the tool options (font size, color, Apply) keeps the editor open.
        const to = e.relatedTarget as HTMLElement | null
        if (to?.closest('[role="toolbar"]')) return
        if (useTextEdit.getState().editing) void commitTextEdit()
      }}
    />
  )
}
