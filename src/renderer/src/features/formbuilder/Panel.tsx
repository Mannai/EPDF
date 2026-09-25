import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { getCommand, runCommand } from '../api'
import { useTabs, type Tab } from '../../state/tabs'
import { useUi } from '../../state/ui'
import { useWorkspace } from '../../state/workspace'
import {
  acceptProposals,
  addAtCenter,
  applyTabOrder,
  applyTabPresetAction,
  cancelDetect,
  clearForm,
  confirmDiscardReview,
  copySelection,
  deleteSelection,
  duplicateSelection,
  enterEdit,
  enterPreview,
  exportCsv,
  isBuilderTool,
  openTabOrder,
  pasteClipboard,
  rejectProposals,
  selectionKeys,
  updateProposal,
  visibleProposals
} from './actions'
import { CheckRow, SelectRow, TextCommit } from './controls'
import { DETECT_KINDS, DETECT_LABEL } from './labels'
import type { DetectKind, Proposal } from './logic/detect'
import { nameProblem } from './logic/names'
import { KIND_LABEL, type FieldInfo } from './logic/spec'
import { PropertiesForm } from './PropertiesForm'
import { CREATE_TOOLS, PANEL_ID, SELECT_TOOL, useBuilder, widgetKey, type DocBuilder } from './store'

/** The right-hand "Form fields" panel: edit / preview switch, field list + properties, detection review, tab order. */

const btn = 'btn h-8 px-2 text-xs'

function ModeSwitch({ docId, editing }: { docId: string; editing: boolean }): JSX.Element {
  return (
    <div role="group" aria-label="Mode" className="flex gap-1 border-b border-line p-2">
      <button type="button" className={`${btn} flex-1 aria-pressed:border-accent aria-pressed:bg-accent/20`} aria-pressed={editing} data-testid="fb-mode-edit" onClick={() => enterEdit(docId)}>
        Edit fields
      </button>
      <button type="button" className={`${btn} flex-1 aria-pressed:border-accent aria-pressed:bg-accent/20`} aria-pressed={!editing} data-testid="fb-mode-preview" onClick={() => enterPreview(docId)}>
        Preview
      </button>
    </div>
  )
}

export function FormBuilderPanel({ tab }: { tab: Tab }): JSX.Element {
  const docId = tab.docId
  const tool = useWorkspace((s) => s.activeTool)
  const mode = useBuilder((s) => s.mode)
  const doc = useBuilder((s) => s.docs[docId])
  const detect = useBuilder((s) => (s.detect?.docId === docId ? s.detect : null))
  const editing = isBuilderTool(tool)

  if (doc?.locked) {
    return <p className="p-3 text-sm">This document is password protected. Unlock it (or remove the password) to build a form.</p>
  }

  if (mode === 'detect' && detect) return <DetectPanel docId={docId} tab={tab} />
  if (mode === 'taborder') return <TabOrderPanel docId={docId} doc={doc} />

  return (
    <div className="flex flex-col" data-testid="fb-panel">
      <ModeSwitch docId={docId} editing={editing} />
      {editing ? <FieldsPanel docId={docId} tab={tab} doc={doc} /> : <PreviewPanel docId={docId} doc={doc} />}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------

const ADD_BUTTONS: { tool: keyof typeof CREATE_TOOLS; label: string }[] = [
  { tool: 'formbuilder.text', label: 'Text field' },
  { tool: 'formbuilder.checkbox', label: 'Check box' },
  { tool: 'formbuilder.radio', label: 'Radio group' },
  { tool: 'formbuilder.dropdown', label: 'Dropdown' },
  { tool: 'formbuilder.list', label: 'List box' },
  { tool: 'formbuilder.date', label: 'Date field' },
  { tool: 'formbuilder.signature', label: 'Signature' },
  { tool: 'formbuilder.button', label: 'Button' }
]

function FieldsPanel({ docId, tab, doc }: { docId: string; tab: Tab; doc: DocBuilder | undefined }): JSX.Element {
  const selection = useBuilder((s) => (s.selectionDoc === docId ? s.selection : []))
  const clipboard = useBuilder((s) => s.clipboard)
  const fields = doc?.fields ?? []
  const has = selection.length > 0

  return (
    <div>
      <section aria-label="Add fields" className="border-b border-line px-3 py-2">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">Add to this page</h3>
        <div className="grid grid-cols-2 gap-1">
          {ADD_BUTTONS.map((b) => (
            <button key={b.tool} type="button" className={btn} onClick={() => void addAtCenter(docId, CREATE_TOOLS[b.tool])} title={`Add a ${b.label.toLowerCase()} to page ${tab.view.page}`}>
              {b.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-ink-muted">Or choose a tool in the ribbon and draw the field on the page.</p>
      </section>

      <section aria-label="Actions" className="grid grid-cols-2 gap-1 border-b border-line px-3 py-2">
        <button type="button" className={btn} onClick={() => void runCommand('formbuilder.detect')}>
          Detect fields…
        </button>
        <button type="button" className={btn} onClick={() => openTabOrder(docId)} disabled={fields.length === 0}>
          Tab order…
        </button>
        <button type="button" className={btn} onClick={() => copySelection(docId)} disabled={!has}>
          Copy
        </button>
        <button type="button" className={btn} onClick={() => void pasteClipboard(docId, Math.max(0, tab.view.page - 1))} disabled={!clipboard}>
          Paste
        </button>
        <button type="button" className={btn} onClick={() => void duplicateSelection(docId)} disabled={!has}>
          Duplicate
        </button>
        <button type="button" className={btn} onClick={() => void deleteSelection(docId)} disabled={!has}>
          Delete
        </button>
        <button type="button" className={btn} onClick={() => void exportCsv(docId)} disabled={fields.length === 0}>
          Export list (CSV)
        </button>
        <button type="button" className={btn} onClick={() => void clearForm(docId)} disabled={fields.length === 0}>
          Clear form
        </button>
      </section>

      <FieldList docId={docId} fields={fields} selection={selection} />
      {doc && <PropertiesForm docId={docId} doc={doc} />}
      {!doc && <p className="px-3 py-3 text-xs text-ink-muted">Reading the form…</p>}
    </div>
  )
}

function FieldList({ docId, fields, selection }: { docId: string; fields: FieldInfo[]; selection: string[] }): JSX.Element {
  return (
    <section aria-label="Fields in this document" className="border-b border-line px-3 py-2">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted" data-testid="fb-field-count">
        Fields ({fields.length})
      </h3>
      {fields.length === 0 ? (
        <p className="text-xs text-ink-muted">This document has no form fields yet. Detect them automatically, or add them by hand.</p>
      ) : (
        <ul className="max-h-40 overflow-y-auto" data-testid="fb-field-list">
          {fields.map((f) => {
            const selected = f.widgets.some((w) => selection.includes(widgetKey(f.name, w.index)))
            return (
              <li key={f.name}>
                <button
                  type="button"
                  aria-pressed={selected}
                  data-field-row={f.name}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent aria-pressed:bg-accent/20"
                  onClick={(e) => {
                    const keys = f.widgets.map((w) => widgetKey(f.name, w.index))
                    if (e.shiftKey || e.ctrlKey || e.metaKey) useBuilder.getState().toggleKey(docId, keys[0])
                    else useBuilder.getState().select(docId, keys.slice(0, 1))
                    void goToField(docId, keys[0], f.widgets[0].pageIndex)
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="shrink-0 text-ink-muted">{KIND_LABEL[f.kind]}</span>
                  {f.required && <span className="shrink-0 text-ink-muted">required</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** Scrolls to a field's page and (if it is drawn there) focuses it. */
export async function goToField(docId: string, key: string, pageIndex: number): Promise<void> {
  const tab = useTabs.getState().tabs.find((t) => t.docId === docId)
  if (tab && tab.view.page !== pageIndex + 1) useTabs.getState().goToPage(docId, pageIndex + 1)
  const sel = `[data-widget-key="${key.replace(/["\\]/g, '\\$&')}"], [data-fb-key="${key.replace(/["\\]/g, '\\$&')}"]`
  for (let i = 0; i < 20; i++) {
    const el = document.querySelector<HTMLElement>(sel)
    if (el) {
      el.scrollIntoView({ block: 'center', inline: 'nearest' })
      return
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

// ---------------------------------------------------------------------------------------------------------

function PreviewPanel({ docId, doc }: { docId: string; doc: DocBuilder | undefined }): JSX.Element {
  const [checked, setChecked] = useState<string[] | null>(null)
  const fields = doc?.fields ?? []
  const emptyRequired = (): FieldInfo[] => fields.filter((f) => f.required && !f.readOnly && !f.hidden && (f.kind === 'checkbox' ? f.value !== 'true' : f.value === ''))
  return (
    <div className="grid gap-2 p-3 text-xs" data-testid="fb-preview">
      <p>
        <strong>Preview.</strong> The form behaves as it will for the people who fill it in: click and type in the fields, use Tab to move between them. Choose <em>Edit fields</em> to go back to building.
      </p>
      <p className="text-ink-muted">Formats and limits you set are checked while you type. Required fields are announced to screen readers.</p>
      <div className="grid grid-cols-2 gap-1">
        <button type="button" className={btn} onClick={() => void clearForm(docId)} disabled={fields.length === 0}>
          Clear form
        </button>
        <button
          type="button"
          className={btn}
          data-testid="fb-check-required"
          onClick={() => {
            const names = emptyRequired().map((f) => f.name)
            setChecked(names)
            useUi.getState().announce(names.length === 0 ? 'All required fields are filled in' : `${names.length} required ${names.length === 1 ? 'field is' : 'fields are'} empty`)
          }}
        >
          Check required fields
        </button>
      </div>
      {checked && (
        <div role="status" data-testid="fb-required-result">
          {checked.length === 0 ? (
            <p>Every required field is filled in.</p>
          ) : (
            <>
              <p>
                {checked.length} required {checked.length === 1 ? 'field is' : 'fields are'} empty:
              </p>
              <ul className="mt-1 list-disc pl-4">
                {checked.map((n) => {
                  const f = fields.find((x) => x.name === n)!
                  return (
                    <li key={n}>
                      <button type="button" className="underline" onClick={() => void goToField(docId, widgetKey(n, f.widgets[0].index), f.widgets[0].pageIndex)}>
                        {f.tooltip || n}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------
// detection review

const pct = (n: number): string => `${Math.round(n * 100)}%`

function DetectPanel({ docId, tab }: { docId: string; tab: Tab }): JSX.Element {
  const d = useBuilder((s) => s.detect)!
  const shown = visibleProposals(d)
  const selectedShown = shown.filter((p) => d.selected.includes(p.id))
  const counts = Object.fromEntries(DETECT_KINDS.map((k) => [k, d.items.filter((p) => p.kind === k && p.confidence >= d.threshold).length])) as Record<DetectKind, number>
  const notes = d.results.filter((r) => r.note)
  const current = selectedShown.length === 1 ? selectedShown[0] : null
  const set = useBuilder.getState().patchDetect

  const close = async (): Promise<void> => {
    if (await confirmDiscardReview()) {
      cancelDetect()
      useBuilder.getState().setMode('fields')
    }
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement && e.target.type === 'text')) {
      e.stopPropagation()
      void close()
    }
  }

  if (d.phase === 'running') {
    return (
      <div className="grid gap-2 p-3 text-sm" role="status" data-testid="fb-detect-running" onKeyDown={onKeyDown}>
        <p>
          Analysing page {Math.min(d.progress.done + 1, Math.max(1, d.progress.total))} of {Math.max(1, d.progress.total)}…
        </p>
        <progress className="w-full" max={Math.max(1, d.progress.total)} value={d.progress.done} aria-label="Detection progress" />
        <button type="button" className={btn} onClick={() => cancelDetect()}>
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col" data-testid="fb-detect" onKeyDown={onKeyDown}>
      <div className="border-b border-line px-3 py-2">
        <h3 className="text-sm font-semibold">Detected fields</h3>
        <p className="mt-1 text-xs text-ink-muted" role="status" data-testid="fb-detect-summary">
          {d.items.length === 0 ? 'No fields were found.' : `${shown.length} of ${d.items.length} suggestions shown. Nothing is added until you create them.`}
        </p>
      </div>

      {notes.length > 0 && (
        <div className="border-b border-line px-3 py-2 text-xs" data-testid="fb-detect-notes">
          {notes.map((r) => (
            <p key={r.pageIndex} className="mb-1">
              <strong>Page {r.pageIndex + 1}:</strong> {r.note}
            </p>
          ))}
          {notes.some((r) => r.status === 'scanned') && getCommand('ocr.open') && (
            <button type="button" className={btn} onClick={() => void runCommand('ocr.open')}>
              Run OCR…
            </button>
          )}
        </div>
      )}

      <div className="grid gap-2 border-b border-line px-3 py-2 text-xs">
        <label htmlFor="fb-threshold" className="flex items-center justify-between">
          <span>Minimum confidence</span>
          <output htmlFor="fb-threshold" data-testid="fb-threshold-value">
            {pct(d.threshold)}
          </output>
        </label>
        <input
          id="fb-threshold"
          type="range"
          min={0.3}
          max={1}
          step={0.05}
          value={d.threshold}
          onChange={(e) => set({ threshold: Number(e.target.value) })}
          onKeyDown={(e) => e.stopPropagation()}
          aria-valuetext={pct(d.threshold)}
        />
        <fieldset className="grid grid-cols-2 gap-x-2 gap-y-1">
          <legend className="mb-1">Show these kinds</legend>
          {DETECT_KINDS.map((k) => (
            <CheckRow key={k} label={`${DETECT_LABEL[k]} (${counts[k]})`} checked={d.kinds[k]} onChange={(v) => set({ kinds: { ...d.kinds, [k]: v } })} />
          ))}
        </fieldset>
      </div>

      <div className="grid grid-cols-2 gap-1 border-b border-line px-3 py-2">
        <button type="button" className="btn-primary h-8 px-2 text-xs" data-testid="fb-accept-all" disabled={shown.length === 0 || d.phase === 'applying'} onClick={() => void acceptProposals(docId, shown)}>
          Create all shown ({shown.length})
        </button>
        <button type="button" className={btn} data-testid="fb-accept-selected" disabled={selectedShown.length === 0 || d.phase === 'applying'} onClick={() => void acceptProposals(docId, selectedShown)}>
          Create selected ({selectedShown.length})
        </button>
        <button type="button" className={btn} data-testid="fb-reject-selected" disabled={selectedShown.length === 0} onClick={() => rejectProposals(selectedShown.map((p) => p.id))}>
          Reject selected
        </button>
        <button type="button" className={btn} onClick={() => set({ selected: selectedShown.length === shown.length ? [] : shown.map((p) => p.id) })} disabled={shown.length === 0}>
          {selectedShown.length === shown.length && shown.length > 0 ? 'Select none' : 'Select all'}
        </button>
        <button type="button" className={`${btn} col-span-2`} data-testid="fb-detect-close" onClick={() => void close()}>
          Close without adding
        </button>
      </div>

      {current && <ProposalEditor docId={docId} p={current} taken={new Set(d.items.filter((x) => x.id !== current.id).map((x) => x.name.toLowerCase()))} />}

      <ul className="px-3 py-2" aria-label="Suggested fields" data-testid="fb-proposals">
        {shown.map((p) => (
          <li key={p.id} className="flex items-start gap-2 py-0.5 text-xs">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-[rgb(var(--c-accent))]"
              checked={d.selected.includes(p.id)}
              aria-label={`Select suggestion ${p.name}`}
              onChange={(e) => set({ selected: e.target.checked ? [...d.selected, p.id] : d.selected.filter((s) => s !== p.id) })}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              className="min-w-0 flex-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onClick={() => {
                set({ selected: [p.id] })
                if (tab.view.page !== p.pageIndex + 1) useTabs.getState().goToPage(docId, p.pageIndex + 1)
                void goToField(docId, p.id, p.pageIndex)
              }}
            >
              <span className="block truncate font-medium">{p.name}</span>
              <span className="block text-ink-muted">
                {DETECT_LABEL[p.kind]} · page {p.pageIndex + 1} · {pct(p.confidence)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

const TEXT_LIKE: DetectKind[] = ['text', 'date', 'signature']

function ProposalEditor({ docId, p, taken }: { docId: string; p: Proposal; taken: Set<string> }): JSX.Element {
  void docId
  return (
    <section aria-label="Selected suggestion" className="grid gap-2 border-b border-line px-3 py-2" data-testid="fb-proposal-editor">
      <TextCommit
        label="Name"
        value={p.name}
        validate={(v) => nameProblem(v) ?? (taken.has(v.toLowerCase()) ? `A field named “${v}” is already suggested.` : null)}
        onCommit={(v) => updateProposal(p.id, { name: v })}
        inputProps={{ 'data-testid': 'fb-proposal-name' }}
      />
      <TextCommit label="Label (becomes the tooltip)" value={p.label ?? ''} onCommit={(v) => updateProposal(p.id, { label: v })} />
      {TEXT_LIKE.includes(p.kind) && (
        <SelectRow label="Kind" value={p.kind} options={TEXT_LIKE.map((k) => ({ value: k, label: DETECT_LABEL[k] }))} onChange={(v) => updateProposal(p.id, { kind: v as DetectKind })} />
      )}
      <p className="text-[11px] text-ink-muted">{p.reason}</p>
      <p className="text-[11px] text-ink-muted">Drag the box on the page to move it, drag a handle to resize it. Arrow keys move it, Alt with arrows resizes it, Delete rejects it.</p>
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------
// tab order

function TabOrderPanel({ docId, doc }: { docId: string; doc: DocBuilder | undefined }): JSX.Element {
  const t = useBuilder((s) => s.taborder)
  const listRef = useRef<HTMLOListElement>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const pages = doc?.tabs ?? []
  const info = pages.find((p) => p.pageIndex === t?.pageIndex)

  // The document reloaded (after Apply / a preset): show the order it now has, unless there are unsaved changes.
  useEffect(() => {
    const st = useBuilder.getState().taborder
    if (!st || !info) return
    const keys = info.entries.map((e) => e.key)
    const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])
    const unsaved = !same(st.keys, st.saved) && st.keys.length > 0 && st.keys.every((k) => keys.includes(k)) && st.keys.length === keys.length
    if (!unsaved && (!same(st.saved, keys) || st.keys.length === 0)) useBuilder.getState().setTabOrder({ ...st, keys, saved: keys })
  }, [doc?.key, info])

  if (!t || t.docId !== docId) return <p className="p-3 text-xs">Nothing to order.</p>
  const label = (k: string): { name: string; kind: string } => {
    const e = info?.entries.find((x) => x.key === k)
    return { name: e ? `${e.label}${e.kind === 'radio' ? ` (${e.key.split('#')[1]})` : ''}` : k, kind: e ? KIND_LABEL[e.kind] : '' }
  }
  const dirty = t.keys.join('|') !== t.saved.join('|')
  const set = (keys: string[], focusKey: string | null): void => useBuilder.getState().setTabOrder({ ...t, keys, focusKey })

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= t.keys.length || from === to) return
    const keys = [...t.keys]
    const [k] = keys.splice(from, 1)
    keys.splice(to, 0, k)
    set(keys, k)
    useUi.getState().announce(`${label(k).name} is now number ${to + 1} of ${keys.length}`)
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-order-key="${CSS.escape(k)}"]`)?.focus())
  }
  const onRowKey = (e: KeyboardEvent, i: number): void => {
    e.stopPropagation()
    if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault()
      move(i, i - 1)
    } else if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault()
      move(i, i + 1)
    } else if (e.key === 'Home' && e.altKey) {
      e.preventDefault()
      move(i, 0)
    } else if (e.key === 'End' && e.altKey) {
      e.preventDefault()
      move(i, t.keys.length - 1)
    }
  }
  const close = (): void => {
    useBuilder.getState().setTabOrder(null)
    useBuilder.getState().setMode('fields')
  }
  const drop = (e: DragEvent, to: number): void => {
    e.preventDefault()
    const from = dragKey ? t.keys.indexOf(dragKey) : -1
    setDragKey(null)
    if (from >= 0) move(from, to)
  }

  return (
    <div className="flex flex-col" data-testid="fb-taborder" onKeyDown={(e) => e.key === 'Escape' && !(e.target instanceof HTMLSelectElement) && (e.stopPropagation(), close())}>
      <div className="border-b border-line px-3 py-2">
        <h3 className="text-sm font-semibold">Tab order</h3>
        <p className="mt-1 text-xs text-ink-muted">
          The order in which the Tab key visits the fields of a page. Move rows with the buttons, drag them, or press Alt+Up / Alt+Down. The numbers on the page show the order.
        </p>
      </div>
      <div className="grid gap-2 border-b border-line px-3 py-2">
        <SelectRow
          label="Page"
          value={String(t.pageIndex)}
          options={pages.map((p) => ({ value: String(p.pageIndex), label: `Page ${p.pageIndex + 1}` }))}
          onChange={(v) => {
            const p = pages.find((x) => x.pageIndex === Number(v))
            if (p) {
              const keys = p.entries.map((e) => e.key)
              useBuilder.getState().setTabOrder({ ...t, pageIndex: p.pageIndex, keys, saved: keys, focusKey: keys[0] ?? null })
              useTabs.getState().goToPage(docId, p.pageIndex + 1)
            }
          }}
        />
        <p className="text-xs text-ink-muted" data-testid="fb-tabs-mode">
          Current setting: {info?.mode === 'S' ? 'custom order (structure)' : info?.mode === 'R' ? 'rows' : info?.mode === 'C' ? 'columns' : 'not set (rows)'}
        </p>
        <div className="grid grid-cols-2 gap-1">
          <button type="button" className={btn} onClick={() => void applyTabPresetAction(docId, 'row')}>
            By rows
          </button>
          <button type="button" className={btn} onClick={() => void applyTabPresetAction(docId, 'column')}>
            By columns
          </button>
        </div>
      </div>
      <ol ref={listRef} className="px-3 py-2" aria-label={`Tab order of page ${t.pageIndex + 1}`} data-testid="fb-order-list">
        {t.keys.map((k, i) => {
          const l = label(k)
          return (
            <li
              key={k}
              draggable
              data-order-key={k}
              tabIndex={0}
              aria-label={`${i + 1} of ${t.keys.length}: ${l.name}, ${l.kind}. Alt plus arrow up or down moves it.`}
              className={`flex items-center gap-2 rounded border border-transparent px-1.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent ${dragKey === k ? 'opacity-50' : ''} ${t.focusKey === k ? 'bg-accent/15' : ''}`}
              onDragStart={(e) => {
                setDragKey(k)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', k)
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => drop(e, i)}
              onDragEnd={() => setDragKey(null)}
              onFocus={() => t.focusKey !== k && set(t.keys, k)}
              onKeyDown={(e) => onRowKey(e, i)}
            >
              <span aria-hidden="true" className="w-6 shrink-0 text-right font-semibold">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{l.name}</span>
                <span className="block text-ink-muted">{l.kind}</span>
              </span>
              <button type="button" className="btn-icon h-7 w-7" aria-label={`Move ${l.name} up`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                <span aria-hidden="true">↑</span>
              </button>
              <button type="button" className="btn-icon h-7 w-7" aria-label={`Move ${l.name} down`} disabled={i === t.keys.length - 1} onClick={() => move(i, i + 1)}>
                <span aria-hidden="true">↓</span>
              </button>
            </li>
          )
        })}
      </ol>
      <div className="grid grid-cols-2 gap-1 border-t border-line px-3 py-2">
        <button type="button" className="btn-primary h-8 px-2 text-xs" data-testid="fb-taborder-apply" disabled={!dirty} onClick={() => void applyTabOrder(docId)}>
          Apply order
        </button>
        <button type="button" className={btn} disabled={!dirty} onClick={() => set([...t.saved], t.focusKey)}>
          Revert
        </button>
        <button type="button" className={`${btn} col-span-2`} data-testid="fb-taborder-close" onClick={close}>
          Done
        </button>
      </div>
    </div>
  )
}

export { PANEL_ID, SELECT_TOOL, selectionKeys }
