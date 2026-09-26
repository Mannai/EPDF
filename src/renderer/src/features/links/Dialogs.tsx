import { useEffect, useRef, useState } from 'react'
import { Modal } from '../../components/Modal'
import { useTabs } from '../../state/tabs'
import { errorMessage } from '../../state/notify'
import { addDetectedLinks, createLinks, saveLinkEdit } from './actions'
import { announce, readCurrent, unlock } from './common'
import { refreshLinks, useDocLinks } from './data'
import { describeTarget } from './pdf/model'
import { detectLinks, type DetectedLink } from './pdf/detect'
import { checkUrl } from './pdf/url'
import { useLinkUi, type BorderStyle, type LinkForm, type PageView } from './store'

/** The dialogs of the links feature: create/edit a link, and review auto-detected addresses. */

const BORDER_LABEL: Record<BorderStyle, string> = { none: 'No border (invisible)', thin: 'Thin outline', dashed: 'Dashed outline' }

export function LinkDialogHost(): JSX.Element | null {
  const dialog = useLinkUi((s) => s.dialog)
  const picking = useLinkUi((s) => s.picking)
  if (!dialog) return null
  if (picking) return <PickBanner />
  return <LinkDialog key={dialog.mode === 'edit' ? dialog.link.id : 'new'} />
}

/** Shown while the dialog is hidden and the user clicks the target position on a page. */
function PickBanner(): JSX.Element {
  return (
    <div className="fixed inset-x-0 top-14 z-[58] flex justify-center px-4" role="status">
      <div className="flex items-center gap-3 rounded-lg border border-accent bg-raised px-4 py-2 shadow-lg">
        <span>Click the spot on any page that the link should open. Press Escape to go back.</span>
        <button className="btn" onClick={() => useLinkUi.getState().setPicking(false)}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function LinkDialog(): JSX.Element | null {
  const dialog = useLinkUi((s) => s.dialog)
  const form = useLinkUi((s) => s.form)
  const patch = useLinkUi((s) => s.patchForm)
  const close = useLinkUi((s) => s.closeDialog)
  const docId = dialog?.docId ?? null
  const numPages = useTabs((s) => s.tabs.find((t) => t.docId === docId)?.numPages ?? 1)
  const data = useDocLinks(docId, true)
  const [busy, setBusy] = useState(false)
  if (!dialog) return null
  const editing = dialog.mode === 'edit'
  const foreign = editing && (dialog.link.target.kind === 'other')
  const names = data?.names ?? []

  const urlCheck = form.kind === 'uri' ? checkUrl(form.uri) : null
  const pageOk = Number.isInteger(form.page) && form.page >= 1 && form.page <= numPages
  const problem =
    foreign ? null : form.kind === 'uri' ? (urlCheck && !urlCheck.ok && (form.uri.trim() || !editing) ? urlCheck.reason : null) : form.kind === 'page' ? (pageOk ? null : `Enter a page number from 1 to ${numPages}.`) : form.named ? null : 'Choose a named destination.'
  const canSave = !busy && (foreign || (form.kind === 'uri' ? !!urlCheck?.ok : form.kind === 'page' ? pageOk : !!form.named))

  const submit = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    const ok = dialog.mode === 'create' ? await createLinks(dialog.docId, dialog.regions, form) : await saveLinkEdit(dialog.docId, dialog.link, form)
    setBusy(false)
    if (ok) close()
  }

  const title = editing ? 'Edit link' : 'Add link'
  const regions = dialog.mode === 'create' ? dialog.regions : []
  return (
    <Modal title={title} onClose={close} wide>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {regions.length > 0 && (
          <p className="text-ink-muted">
            {regions.length === 1
              ? `On page ${regions[0].pageIndex + 1}${regions[0].quads.length > 1 ? `, covering ${regions[0].quads.length} lines of text` : ''}.`
              : `One link on each of ${regions.length} pages (${regions.map((r) => r.pageIndex + 1).join(', ')}).`}
          </p>
        )}

        {foreign ? (
          <p role="note" className="rounded-md border border-line bg-surface-alt p-2">
            This link does something Epdf does not change ({describeTarget(dialog.link.target)}). It is kept exactly as it is; you can still move, resize, restyle or delete it.
          </p>
        ) : (
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 font-medium">Link to</legend>

            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2">
                <input type="radio" name="link-kind" checked={form.kind === 'uri'} onChange={() => patch({ kind: 'uri' })} />
                <span>A web address, e-mail address or phone number</span>
              </label>
              {form.kind === 'uri' && (
                <>
                  <input
                    autoFocus
                    type="text"
                    dir="ltr"
                    inputMode="url"
                    spellCheck={false}
                    aria-label="Address"
                    aria-invalid={!!problem}
                    aria-describedby={problem ? 'link-problem' : undefined}
                    placeholder="https://example.com"
                    value={form.uri}
                    onChange={(e) => patch({ uri: e.target.value })}
                    className="field ms-6 text-start"
                  />
                  {problem && (
                    <span id="link-problem" role="alert" className="ms-6 text-sm text-danger">
                      Problem: {problem}
                    </span>
                  )}
                </>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2">
                <input type="radio" name="link-kind" checked={form.kind === 'page'} onChange={() => patch({ kind: 'page', view: editing && dialog.link.target.kind === 'page' ? form.view : 'top' })} />
                <span>A page in this document</span>
              </label>
              {form.kind === 'page' && (
                <div className="ms-6 flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2">
                      <span>Page</span>
                      <input
                        type="number"
                        min={1}
                        max={numPages}
                        aria-label="Target page"
                        aria-invalid={!pageOk}
                        value={Number.isFinite(form.page) ? form.page : ''}
                        onChange={(e) => patch({ page: e.target.value === '' ? NaN : Number(e.target.value), view: form.view === 'keep' ? 'top' : form.view, pos: null })}
                        className="field w-20"
                      />
                      <span className="text-ink-muted">of {numPages}</span>
                    </label>
                    <label className="flex items-center gap-2">
                      <span>Open at</span>
                      <select
                        aria-label="How the page opens"
                        value={form.view}
                        onChange={(e) => patch({ view: e.target.value as PageView })}
                        className="field"
                      >
                        {editing && dialog.link.target.kind === 'page' && dialog.link.target.dest.pageIndex === form.page - 1 && <option value="keep">As in the file</option>}
                        <option value="top">Top of the page, current zoom</option>
                        <option value="fit">Whole page</option>
                        <option value="fitwidth">Page width</option>
                        <option value="position">A spot I choose on the page</option>
                      </select>
                    </label>
                    {(form.view === 'top' || form.view === 'position') && (
                      <label className="flex items-center gap-2">
                        <span>Zoom</span>
                        <select aria-label="Zoom when opened" value={form.zoom === null ? '' : String(form.zoom)} onChange={(e) => patch({ zoom: e.target.value === '' ? null : Number(e.target.value) })} className="field">
                          <option value="">Keep the reader’s zoom</option>
                          {[0.5, 0.75, 1, 1.25, 1.5, 2, 4].map((z) => (
                            <option key={z} value={String(z)}>
                              {Math.round(z * 100)}%
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="btn" onClick={() => useLinkUi.getState().setPicking(true)}>
                      Choose the spot on a page…
                    </button>
                    {form.pos && form.view === 'position' && (
                      <span className="text-sm text-ink-muted" data-testid="link-picked">
                        Page {form.page}, {Math.round(form.pos.fx * 100)}% from the left, {Math.round(form.pos.fy * 100)}% from the top
                      </span>
                    )}
                  </div>
                  {problem && (
                    <span role="alert" className="text-sm text-danger">
                      Problem: {problem}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2">
                <input type="radio" name="link-kind" checked={form.kind === 'named'} onChange={() => patch({ kind: 'named' })} disabled={names.length === 0 && form.kind !== 'named'} />
                <span>A named destination{names.length === 0 ? ' (this document has none)' : ''}</span>
              </label>
              {form.kind === 'named' && (
                <select aria-label="Named destination" value={form.named} onChange={(e) => patch({ named: e.target.value })} className="field ms-6" dir="auto">
                  <option value="">Choose…</option>
                  {names.map((n) => (
                    <option key={n.name} value={n.name}>
                      {n.name}
                      {n.pageIndex !== null ? ` (page ${n.pageIndex + 1})` : ' (broken)'}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </fieldset>
        )}

        <fieldset className="flex flex-wrap items-center gap-3">
          <legend className="mb-1 font-medium">Appearance</legend>
          <label className="flex items-center gap-2">
            <span>Border</span>
            <select aria-label="Border" value={form.border} onChange={(e) => patch({ border: e.target.value as BorderStyle })} className="field">
              {(['none', 'thin', 'dashed'] as const).map((b) => (
                <option key={b} value={b}>
                  {BORDER_LABEL[b]}
                </option>
              ))}
            </select>
          </label>
          {form.border !== 'none' && (
            <label className="flex items-center gap-2">
              <span>Colour</span>
              <input type="color" aria-label="Border colour" value={form.color} onChange={(e) => patch({ color: e.target.value })} className="h-8 w-10 cursor-pointer rounded border border-line bg-transparent p-0" />
            </label>
          )}
        </fieldset>

        <label className="flex flex-col gap-1">
          <span>Description (optional, shown by some readers as a tooltip)</span>
          <input type="text" dir="auto" aria-label="Description" value={form.contents} maxLength={500} onChange={(e) => patch({ contents: e.target.value })} className="field text-start" />
        </label>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!canSave}>
            {editing ? 'Save link' : 'Create link'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ---------------------------------------------------------------- auto-detect

export function DetectDialogHost(): JSX.Element | null {
  const target = useLinkUi((s) => s.detect)
  if (!target) return null
  return <DetectBody key={target.docId} docId={target.docId} />
}

type DetectPhase = { kind: 'working'; page: number; total: number } | { kind: 'review' } | { kind: 'error'; message: string }

function DetectBody({ docId }: { docId: string }): JSX.Element {
  const close = (): void => useLinkUi.getState().openDetect(null)
  const [phase, setPhase] = useState<DetectPhase>({ kind: 'working', page: 0, total: 0 })
  const [items, setItems] = useState<(DetectedLink & { accepted: boolean })[]>([])
  const [border, setBorder] = useState<BorderStyle>(useLinkUi.getState().newBorder)
  const [busy, setBusy] = useState(false)
  const stop = useRef(false)
  const data = useDocLinks(docId, true)
  void data

  useEffect(() => {
    let alive = true
    stop.current = false
    void (async () => {
      try {
        if (!(await unlock(docId))) return close()
        const res = await readCurrent(docId)
        if (!res.ok) throw new Error(res.message)
        const { found, stopped } = await detectLinks(res.pdf, {
          onProgress: (p) => alive && setPhase({ kind: 'working', page: p.page, total: p.total }),
          shouldStop: () => stop.current
        })
        if (!alive || stopped) return
        setItems(found.map((f) => ({ ...f, accepted: !f.covered })))
        setPhase({ kind: 'review' })
        announce(found.length ? `${found.length} addresses found` : 'No web or e-mail addresses were found')
      } catch (err) {
        if (alive) setPhase({ kind: 'error', message: errorMessage(err) })
      }
    })()
    return () => {
      alive = false
      stop.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  const chosen = items.filter((i) => i.accepted)
  const patch = (idx: number, accepted: boolean): void => setItems((l) => l.map((it, i) => (i === idx ? { ...it, accepted } : it)))
  const create = async (): Promise<void> => {
    setBusy(true)
    const n = await addDetectedLinks(docId, chosen.map((c) => ({ pageIndex: c.pageIndex, rect: c.rect, url: c.url })), border, useLinkUi.getState().newColor)
    setBusy(false)
    if (n !== undefined) {
      void refreshLinks(docId)
      close()
    }
  }

  return (
    <Modal
      title="Find web and e-mail addresses"
      wide
      onClose={() => {
        stop.current = true
        close()
      }}
    >
      {phase.kind === 'working' && (
        <div className="flex flex-col gap-3" data-testid="detect-working">
          <p role="status">{phase.total ? `Reading page ${phase.page} of ${phase.total}…` : 'Starting…'}</p>
          <progress className="h-2 w-full" value={phase.total ? phase.page / phase.total : 0} max={1} aria-label="Search progress" />
          <div className="flex justify-end">
            <button
              className="btn"
              onClick={() => {
                stop.current = true
                close()
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {phase.kind === 'error' && (
        <div className="flex flex-col gap-3">
          <p role="alert">The document could not be searched: {phase.message}</p>
          <div className="flex justify-end">
            <button className="btn-primary" onClick={close}>
              Close
            </button>
          </div>
        </div>
      )}
      {phase.kind === 'review' && items.length === 0 && (
        <div className="flex flex-col gap-3" data-testid="detect-empty">
          <p role="status">No web or e-mail addresses were found in the text of this document.</p>
          <div className="flex justify-end">
            <button className="btn-primary" onClick={close}>
              Close
            </button>
          </div>
        </div>
      )}
      {phase.kind === 'review' && items.length > 0 && (
        <div className="flex flex-col gap-3" data-testid="detect-review">
          <p className="text-ink-muted">Tick the addresses that should become clickable links. Ones that already have a link are left unticked.</p>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn h-7 px-2 text-xs" onClick={() => setItems((l) => l.map((i) => ({ ...i, accepted: true })))}>
              Select all
            </button>
            <button className="btn h-7 px-2 text-xs" onClick={() => setItems((l) => l.map((i) => ({ ...i, accepted: false })))}>
              Select none
            </button>
            <span className="ms-auto text-xs text-ink-muted" role="status">
              {chosen.length} of {items.length} selected
            </span>
          </div>
          <ul aria-label="Addresses found" className="m-0 max-h-72 list-none overflow-y-auto rounded-md border border-line p-0">
            {items.map((it, idx) => (
              <li key={it.id} data-testid="detect-item" className="flex items-center gap-2 border-b border-line px-2 py-1.5">
                <input type="checkbox" checked={it.accepted} aria-label={`Link ${it.text}`} onChange={(e) => patch(idx, e.target.checked)} />
                <span dir="ltr" className="min-w-0 flex-1 truncate text-start" title={it.url}>
                  {it.text}
                </span>
                <span className="shrink-0 text-xs text-ink-muted">page {it.pageIndex + 1}</span>
                <span className="shrink-0 text-xs text-ink-muted">{it.covered ? 'Already linked' : it.kind === 'email' ? 'E-mail' : 'Web'}</span>
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2">
            <span>Border of the new links</span>
            <select aria-label="Border of the new links" value={border} onChange={(e) => setBorder(e.target.value as BorderStyle)} className="field">
              {(['none', 'thin', 'dashed'] as const).map((b) => (
                <option key={b} value={b}>
                  {BORDER_LABEL[b]}
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={close}>
              Cancel
            </button>
            <button className="btn-primary" disabled={chosen.length === 0 || busy} onClick={() => void create()}>
              {busy ? 'Creating…' : `Create ${chosen.length} ${chosen.length === 1 ? 'link' : 'links'}`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

/** Type helper so `LinkForm` stays referenced for consumers that build forms. */
export type { LinkForm }
