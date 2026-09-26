import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icons'
import { Modal } from '../../components/Modal'
import { EngineChoice } from '../create/EngineChoice'
import { describeKind } from '../create/flow'
import { fmtSize, plural } from '../create/shared'
import { addCombineFiles, itemProblem, runCombine, useCombineUi, type CombineItem } from './flow'
import { dropIndex } from './reorder'

/**
 * The Combine Files screen: an ordered list of files (PDFs and anything convertible) that can be reordered by
 * dragging OR with the keyboard (Alt+Up / Alt+Down on any control in a row, or the Move up / Move down buttons),
 * with per-file page ranges and removal. Reorders are announced to screen readers.
 */
export function CombineDialog(): JSX.Element | null {
  const s = useCombineUi()
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<{ index: number; lower: boolean } | null>(null)
  const pendingFocus = useRef<{ id: string; role: string } | null>(null)

  // After a keyboard move React re-renders the list; put focus back on the control that was used.
  useEffect(() => {
    const p = pendingFocus.current
    if (!p) return
    pendingFocus.current = null
    document.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(p.id)}"] [data-role="${p.role}"]`)?.focus()
  })

  if (!s.open) return null
  const problems = s.items.map((i) => itemProblem(i))
  const anyProblem = problems.some(Boolean)
  const hasOffice = s.items.some((i) => i.kind === 'office')
  const hasImages = s.items.some((i) => i.kind === 'image' || i.kind === 'tiff' || i.kind === 'heic')
  const totalKnown = s.items.every((i) => i.pages !== null)
  const totalPages = s.items.reduce((n, i) => n + (i.pages ?? 0), 0)

  const move = (item: CombineItem, delta: -1 | 1, role: string): void => {
    pendingFocus.current = { id: item.id, role }
    s.move(item.id, delta)
  }

  const onRowKeyDown = (e: React.KeyboardEvent, item: CombineItem): void => {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      e.stopPropagation()
      const role = (e.target as HTMLElement).closest<HTMLElement>('[data-role]')?.dataset['role'] ?? 'handle'
      move(item, e.key === 'ArrowUp' ? -1 : 1, role)
    }
  }

  return (
    <Modal title="Combine files" description="Join several files into one PDF, in the order you choose." onClose={s.close} size={s.items.length ? 'm' : undefined}>
      {s.items.length > 0 && (
        <p id="combine-help" className="mb-2 text-caption text-ink-muted">
          Files are combined from top to bottom. Drag a file to reorder it, or focus its “Reorder” button and press Alt+Up or Alt+Down.
        </p>
      )}
      {s.items.length === 0 ? (
        <div className="mb-4 flex flex-col items-center gap-2.5 rounded border border-dashed border-line-strong bg-surface-alt px-5 py-7 text-center">
          <span className="text-ink-muted">
            <Icon name="file-plus" size={28} />
          </span>
          <p className="m-0 font-semibold">No files yet</p>
          <p className="m-0 text-ink-muted">Add the files you want to join. You can change the order afterwards.</p>
          <button type="button" className="btn" onClick={() => void addCombineFiles()}>
            <Icon name="plus" size={14} />
            Add files…
          </button>
        </div>
      ) : (
        <ul aria-label="Files to combine, in order" className="mb-3 divide-y divide-line rounded-md border border-line" data-testid="combine-list">
          {s.items.map((item, index) => {
            const problem = problems[index]
            const isOver = over?.index === index && dragId !== null && dragId !== item.id
            return (
              <li
                key={item.id}
                data-item-id={item.id}
                data-testid="combine-item"
                draggable
                onDragStart={(e) => {
                  setDragId(item.id)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', item.id)
                }}
                onDragOver={(e) => {
                  if (!dragId) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setOver({ index, lower: e.clientY > r.top + r.height / 2 })
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragId) {
                    const from = s.items.findIndex((i) => i.id === dragId)
                    if (from >= 0 && over) s.moveTo(dragId, dropIndex(from, over.index, over.lower))
                  }
                  setDragId(null)
                  setOver(null)
                }}
                onDragEnd={() => {
                  setDragId(null)
                  setOver(null)
                }}
                onKeyDown={(e) => onRowKeyDown(e, item)}
                className={`flex items-start gap-3 px-3 py-2 ${dragId === item.id ? 'opacity-50' : ''} ${isOver ? (over?.lower ? 'border-b-4 border-b-accent' : 'border-t-4 border-t-accent') : ''}`}
              >
                <span className="mt-1 w-6 shrink-0 text-right text-sm tabular-nums text-ink-muted" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium" title={item.name}>
                    {item.name}
                  </span>
                  <span className="block text-xs text-ink-muted">
                    {describeKind(item)} · {item.pages === null ? 'pages counted when combined' : plural(item.pages, 'page')} · {fmtSize(item.size)}
                  </span>
                  {problem && (
                    <span role="alert" className="mt-1 block text-sm text-danger" data-testid="combine-problem">
                      {item.problem ? 'Cannot be combined: ' : 'Pages: '}
                      {problem}
                    </span>
                  )}
                  <span className="mt-1 flex items-center gap-2">
                    <label htmlFor={`range-${item.id}`} className="text-sm text-ink-muted">
                      Pages
                    </label>
                    <input
                      id={`range-${item.id}`}
                      type="text"
                      className="field w-40 select-text"
                      placeholder="All"
                      aria-label={`Pages to include from ${item.name}`}
                      aria-invalid={!!problem && !item.problem}
                      value={item.range}
                      onChange={(e) => s.setRange(item.id, e.target.value)}
                    />
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    data-role="handle"
                    className="btn-icon cursor-grab"
                    aria-label={`Reorder ${item.name}, position ${index + 1} of ${s.items.length}. Press Alt+Up or Alt+Down to move.`}
                    aria-describedby="combine-help"
                    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  >
                    <span aria-hidden="true">⠿</span>
                  </button>
                  <button type="button" data-role="up" className="btn-icon" aria-label={`Move ${item.name} up`} disabled={index === 0} onClick={() => move(item, -1, 'up')}>
                    <span aria-hidden="true">↑</span>
                  </button>
                  <button type="button" data-role="down" className="btn-icon" aria-label={`Move ${item.name} down`} disabled={index === s.items.length - 1} onClick={() => move(item, 1, 'down')}>
                    <span aria-hidden="true">↓</span>
                  </button>
                  <button type="button" className="btn" aria-label={`Remove ${item.name}`} onClick={() => s.remove(item.id)}>
                    Remove
                  </button>
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <p role="status" aria-live="polite" className="sr-only" data-testid="combine-announce">
        {s.announcement}
      </p>
      <div className={`mb-3 flex items-center justify-between gap-3 ${s.items.length === 0 ? 'sr-only' : ''}`}>
        {s.items.length > 0 && (
          <button type="button" className="btn" onClick={() => void addCombineFiles()}>
            <Icon name="plus" size={14} />
            Add files…
          </button>
        )}
        <span className="text-caption text-ink-muted" data-testid="combine-summary">
          {plural(s.items.length, 'file')}
          {totalKnown && s.items.length > 0 ? ` · ${plural(totalPages, 'page')} before page ranges` : ''}
        </span>
      </div>
      <label className="mb-1 flex items-start gap-2.5">
        <input type="checkbox" className="check" checked={s.bookmarks} onChange={(e) => s.setBookmarks(e.target.checked)} />
        <span className="flex flex-col">
          Add a bookmark for each file
          <span className="text-caption text-ink-muted">Each file’s own bookmarks are kept underneath it.</span>
        </span>
      </label>
      {hasImages && (
        <div className="mb-3">
          <label htmlFor="combine-page-size" className="mb-1 block text-sm font-medium">
            Page size for pictures
          </label>
          <select id="combine-page-size" className="field" value={s.images.pageSize} onChange={(e) => s.setImages({ pageSize: e.target.value as 'image' | 'a4' | 'letter' })}>
            <option value="image">Same size as the picture</option>
            <option value="a4">Fit on A4</option>
            <option value="letter">Fit on Letter</option>
          </select>
        </div>
      )}
      {hasOffice && <EngineChoice env={s.env} engine={s.engine} onChange={s.setEngine} idPrefix="combine" />}
      {hasOffice && s.engine === 'builtin' && <p className="mb-3 text-sm text-ink-muted">Layout of Office documents is approximate.</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={s.close}>
          Cancel
        </button>
        <button type="button" className="btn-primary" disabled={s.items.length === 0 || anyProblem} onClick={runCombine}>
          Combine…
        </button>
      </div>
    </Modal>
  )
}
