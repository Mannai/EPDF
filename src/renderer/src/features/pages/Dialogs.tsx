import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from '../../components/Modal'
import { currentBytes } from '../../edit/session'
import { JobCancelledError, startJob } from '../../state/jobs'
import { errorMessage, notify } from '../../state/notify'
import { useTabs, type Tab } from '../../state/tabs'
import type { PickedFolder, PickedPdf, SplitResult, SplitSpec } from '@shared/features/pages'
import { stemOf } from '@shared/features/pages/filenames'
import { readOutline } from '@shared/features/pages/outline'
import { formatPageList, expandRanges, parsePageRanges } from '@shared/features/pages/ranges'
import { formatBytes, planByBookmarks, planByRanges, planEveryN, type SplitPlan } from '@shared/features/pages/split'
import { deletePages, extractPagesToFile, insertBlank, insertFromPdf, loadPdfLib, rotatePages } from './actions'
import { usePageDialog, type PageDialogPreset } from './store'

/** The page-tool dialogs (insert, blank page, extract, delete, rotate, split). Hosted once; they show themselves. */

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
const rangeText = (pages: number[]): string => formatPageList(pages).replace(/, /g, ',')

function Footer({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="mt-5 flex justify-end gap-2">{children}</div>
}

function ErrorText({ id, children }: { id?: string; children: React.ReactNode }): JSX.Element | null {
  return children ? (
    <p id={id} role="alert" className="mt-1 text-sm text-danger">
      {children}
    </p>
  ) : null
}

function usePagesInput(numPages: number, initial: string): { text: string; setText(v: string): void; pages: number[] | null; error: string } {
  const [text, setText] = useState(initial)
  return useMemo(() => {
    const r = parsePageRanges(text, numPages)
    return r.ok
      ? { text, setText, pages: expandRanges(r.ranges, { unique: true }), error: '' }
      : { text, setText, pages: null, error: text.trim() === '' ? '' : r.error }
  }, [text, numPages])
}

/** Where new pages go, as the gap number (0..n) — shared by the insert and blank-page dialogs. */
type Where = 'start' | 'end' | 'before' | 'after'
function useWhere(numPages: number, preset: PageDialogPreset): { where: Where; setWhere(w: Where): void; pageNum: string; setPageNum(v: string): void; slot: number | null } {
  const last = preset.pages?.length ? Math.max(...preset.pages) + 1 : 0
  const [where, setWhere] = useState<Where>(last ? 'after' : 'end')
  const [pageNum, setPageNum] = useState(String(last || numPages))
  const p = Number(pageNum)
  const validPage = Number.isInteger(p) && p >= 1 && p <= numPages
  const slot = where === 'start' ? 0 : where === 'end' ? numPages : !validPage ? null : where === 'before' ? p - 1 : p
  return { where, setWhere, pageNum, setPageNum, slot }
}

function WherePicker({ w, numPages }: { w: ReturnType<typeof useWhere>; numPages: number }): JSX.Element {
  const needsPage = w.where === 'before' || w.where === 'after'
  const bad = needsPage && w.slot === null
  return (
    <fieldset className="mt-3">
      <legend className="mb-1 text-sm font-medium">Where</legend>
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="where-select">
          Position
        </label>
        <select id="where-select" className="field" value={w.where} onChange={(e) => w.setWhere(e.target.value as Where)}>
          <option value="start">At the beginning</option>
          <option value="end">At the end</option>
          <option value="before">Before page</option>
          <option value="after">After page</option>
        </select>
        {needsPage && (
          <>
            <label className="sr-only" htmlFor="where-page">
              Page number
            </label>
            <input id="where-page" className="field w-20" inputMode="numeric" value={w.pageNum} aria-invalid={bad} onChange={(e) => w.setPageNum(e.target.value.replace(/[^0-9]/g, ''))} />
            <span className="text-sm text-ink-muted">of {numPages}</span>
          </>
        )}
      </div>
      {bad && <ErrorText>Enter a page number from 1 to {numPages}.</ErrorText>}
    </fieldset>
  )
}

// ---- Insert pages from another PDF -----------------------------------------------------------------------------

function InsertDialog({ tab, preset, close }: { tab: Tab; preset: PageDialogPreset; close(): void }): JSX.Element {
  const n = tab.numPages
  const [picked, setPicked] = useState<PickedPdf | null>(null)
  const [srcPages, setSrcPages] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const range = usePagesInput(srcPages || 1, '')
  const where = useWhere(n, preset)

  const choose = async (): Promise<void> => {
    setError('')
    try {
      const p = await window.epdf.call<PickedPdf | null>('pages:pickPdf', {})
      if (!p) return
      const doc = await loadPdfLib(p.bytes, `“${p.name}”`)
      setPicked(p)
      setSrcPages(doc.getPageCount())
      range.setText(doc.getPageCount() === 1 ? '1' : `1-${doc.getPageCount()}`)
    } catch (err) {
      setPicked(null)
      setSrcPages(0)
      setError(errorMessage(err))
    }
  }

  const ready = !!picked && range.pages !== null && where.slot !== null && !busy
  const submit = async (): Promise<void> => {
    if (!picked || !range.pages || where.slot === null) return
    setBusy(true)
    const plan = await insertFromPdf(tab.docId, n, where.slot, picked, range.pages)
    setBusy(false)
    if (plan) close()
  }

  return (
    <Modal title="Insert pages from another PDF" onClose={close} wide>
      <div className="flex items-center gap-3">
        <button className="btn" onClick={() => void choose()} autoFocus>
          Choose PDF…
        </button>
        <span className="text-sm text-ink-muted" data-testid="insert-source">
          {picked ? `${picked.name} (${plural(srcPages, 'page')})` : 'No file chosen'}
        </span>
      </div>
      <ErrorText>{error}</ErrorText>
      <label className="mt-3 block text-sm font-medium" htmlFor="insert-range">
        Pages to insert
      </label>
      <input
        id="insert-range"
        className="field mt-1 w-full"
        value={range.text}
        disabled={!picked}
        placeholder="For example 1-3, 7, 9-"
        aria-invalid={!!range.error}
        aria-describedby="insert-range-error"
        onChange={(e) => range.setText(e.target.value)}
      />
      <ErrorText id="insert-range-error">{range.error}</ErrorText>
      <WherePicker w={where} numPages={n} />
      <Footer>
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn-primary" disabled={!ready} onClick={() => void submit()}>
          Insert
        </button>
      </Footer>
    </Modal>
  )
}

// ---- Insert blank pages ----------------------------------------------------------------------------------------

const PAPERS: Record<string, { label: string; width: number; height: number }> = {
  letter: { label: 'Letter (8.5 × 11 in)', width: 612, height: 792 },
  a4: { label: 'A4 (210 × 297 mm)', width: 595, height: 842 },
  legal: { label: 'Legal (8.5 × 14 in)', width: 612, height: 1008 },
  a3: { label: 'A3 (297 × 420 mm)', width: 842, height: 1191 },
  a5: { label: 'A5 (148 × 210 mm)', width: 420, height: 595 }
}

function BlankDialog({ tab, preset, close }: { tab: Tab; preset: PageDialogPreset; close(): void }): JSX.Element {
  const n = tab.numPages
  const where = useWhere(n, preset)
  const [count, setCount] = useState('1')
  const [size, setSize] = useState('neighbour')
  const [landscape, setLandscape] = useState(false)
  const [busy, setBusy] = useState(false)
  const c = Number(count)
  const countOk = Number.isInteger(c) && c >= 1 && c <= 100

  const submit = async (): Promise<void> => {
    if (where.slot === null || !countOk) return
    setBusy(true)
    const p = PAPERS[size]
    const dims = size === 'neighbour' ? ('neighbour' as const) : landscape ? { width: p.height, height: p.width } : { width: p.width, height: p.height }
    const plan = await insertBlank(tab.docId, n, where.slot, dims, c)
    setBusy(false)
    if (plan) close()
  }

  return (
    <Modal title="Insert blank pages" onClose={close}>
      <label className="block text-sm font-medium" htmlFor="blank-count">
        Number of pages
      </label>
      <input id="blank-count" className="field mt-1 w-24" inputMode="numeric" value={count} aria-invalid={!countOk} autoFocus onChange={(e) => setCount(e.target.value.replace(/[^0-9]/g, ''))} />
      <ErrorText>{countOk ? '' : 'Enter a number from 1 to 100.'}</ErrorText>
      <label className="mt-3 block text-sm font-medium" htmlFor="blank-size">
        Page size
      </label>
      <select id="blank-size" className="field mt-1 w-full" value={size} onChange={(e) => setSize(e.target.value)}>
        <option value="neighbour">Same as the neighbouring page</option>
        {Object.entries(PAPERS).map(([k, v]) => (
          <option key={k} value={k}>
            {v.label}
          </option>
        ))}
      </select>
      {size !== 'neighbour' && (
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={landscape} onChange={(e) => setLandscape(e.target.checked)} />
          Landscape
        </label>
      )}
      <WherePicker w={where} numPages={n} />
      <Footer>
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn-primary" disabled={busy || where.slot === null || !countOk} onClick={() => void submit()}>
          Insert
        </button>
      </Footer>
    </Modal>
  )
}

// ---- Extract ---------------------------------------------------------------------------------------------------

function initialPages(tab: Tab, preset: PageDialogPreset): string {
  return rangeText(preset.pages?.length ? preset.pages : [tab.view.page - 1])
}

function ExtractDialog({ tab, preset, close }: { tab: Tab; preset: PageDialogPreset; close(): void }): JSX.Element {
  const n = tab.numPages
  const range = usePagesInput(n, initialPages(tab, preset))
  const [remove, setRemove] = useState(false)
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    if (!range.pages) return
    setBusy(true)
    const saved = await extractPagesToFile(tab.docId, tab.name, range.pages)
    if (saved && remove) await deletePages(tab.docId, useTabs.getState().tabs.find((t) => t.docId === tab.docId)?.numPages ?? n, range.pages)
    setBusy(false)
    if (saved) close()
  }
  return (
    <Modal title="Extract pages" onClose={close}>
      <p className="mb-3 text-sm text-ink-muted">Saves the pages you choose as a new PDF. The original document is not changed.</p>
      <label className="block text-sm font-medium" htmlFor="extract-range">
        Pages to extract
      </label>
      <input
        id="extract-range"
        className="field mt-1 w-full"
        value={range.text}
        autoFocus
        placeholder="For example 1-3, 7, 9-"
        aria-invalid={!!range.error}
        aria-describedby="extract-range-error"
        onChange={(e) => range.setText(e.target.value)}
      />
      <ErrorText id="extract-range-error">{range.error}</ErrorText>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} />
        Remove these pages from this document afterwards
      </label>
      <Footer>
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn-primary" disabled={busy || !range.pages} onClick={() => void submit()}>
          Extract…
        </button>
      </Footer>
    </Modal>
  )
}

// ---- Delete ----------------------------------------------------------------------------------------------------

function DeleteDialog({ tab, preset, close }: { tab: Tab; preset: PageDialogPreset; close(): void }): JSX.Element {
  const n = tab.numPages
  const range = usePagesInput(n, initialPages(tab, preset))
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    if (!range.pages) return
    setBusy(true)
    const plan = await deletePages(tab.docId, n, range.pages)
    setBusy(false)
    if (plan) close()
  }
  return (
    <Modal title="Delete pages" onClose={close}>
      <label className="block text-sm font-medium" htmlFor="delete-range">
        Pages to delete
      </label>
      <input id="delete-range" className="field mt-1 w-full" value={range.text} autoFocus aria-invalid={!!range.error} aria-describedby="delete-range-error" onChange={(e) => range.setText(e.target.value)} />
      <ErrorText id="delete-range-error">{range.error}</ErrorText>
      <p className="mt-2 text-sm text-ink-muted">The document has {plural(n, 'page')}. You can undo this until you close the document.</p>
      <Footer>
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn-primary" disabled={busy || !range.pages} onClick={() => void submit()}>
          Delete
        </button>
      </Footer>
    </Modal>
  )
}

// ---- Rotate ----------------------------------------------------------------------------------------------------

function RotateDialog({ tab, preset, close }: { tab: Tab; preset: PageDialogPreset; close(): void }): JSX.Element {
  const n = tab.numPages
  const range = usePagesInput(n, initialPages(tab, preset))
  const [dir, setDir] = useState<'90' | '-90' | '180'>('90')
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    if (!range.pages) return
    setBusy(true)
    const ok = await rotatePages(tab.docId, n, range.pages, Number(dir) as 90 | -90 | 180)
    setBusy(false)
    if (ok) close()
  }
  return (
    <Modal title="Rotate pages" onClose={close}>
      <label className="block text-sm font-medium" htmlFor="rotate-range">
        Pages to rotate
      </label>
      <input id="rotate-range" className="field mt-1 w-full" value={range.text} autoFocus aria-invalid={!!range.error} aria-describedby="rotate-range-error" onChange={(e) => range.setText(e.target.value)} />
      <ErrorText id="rotate-range-error">{range.error}</ErrorText>
      <fieldset className="mt-3">
        <legend className="mb-1 text-sm font-medium">Direction</legend>
        {(
          [
            ['90', 'Clockwise 90°'],
            ['-90', 'Counterclockwise 90°'],
            ['180', 'Upside down (180°)']
          ] as const
        ).map(([v, label]) => (
          <label key={v} className="flex items-center gap-2 py-0.5 text-sm">
            <input type="radio" name="rotate-dir" value={v} checked={dir === v} onChange={() => setDir(v)} />
            {label}
          </label>
        ))}
      </fieldset>
      <Footer>
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn-primary" disabled={busy || !range.pages} onClick={() => void submit()}>
          Rotate
        </button>
      </Footer>
    </Modal>
  )
}

// ---- Split -----------------------------------------------------------------------------------------------------

type SplitMode = 'ranges' | 'every' | 'size' | 'bookmarks'

function SplitDialog({ tab, close }: { tab: Tab; close(): void }): JSX.Element {
  const n = tab.numPages
  const [mode, setMode] = useState<SplitMode>('ranges')
  const half = Math.max(1, Math.ceil(n / 2))
  const ranges = usePagesInput(n, n > 1 ? `1-${half}, ${half + 1}-` : '1')
  const [every, setEvery] = useState(String(Math.min(10, n)))
  const [sizeValue, setSizeValue] = useState('5')
  const [sizeUnit, setSizeUnit] = useState<'MB' | 'KB'>('MB')
  const [folder, setFolder] = useState<PickedFolder | null>(null)
  const [stage, setStage] = useState<'setup' | 'running' | 'done'>('setup')
  const [error, setError] = useState('')
  const [result, setResult] = useState<SplitResult | null>(null)
  const cancelRef = useRef<(() => void) | null>(null)

  // Bookmarks: read them from the current content when that mode is chosen.
  const [marks, setMarks] = useState<SplitPlan | 'loading' | null>(null)
  useEffect(() => {
    if (mode !== 'bookmarks') return
    let live = true
    setMarks('loading')
    void (async () => {
      try {
        const doc = await loadPdfLib(await currentBytes(tab.docId), 'This document')
        const { nodes, warnings } = readOutline(doc)
        const plan = planByBookmarks(nodes, doc.getPageCount())
        if (live) setMarks({ parts: plan.parts, warnings: [...warnings, ...plan.warnings] })
      } catch (err) {
        if (live) setMarks({ parts: [], warnings: [errorMessage(err)] })
      }
    })()
    return () => {
      live = false
    }
  }, [mode, tab.docId])

  const everyN = Number(every)
  const sizeN = Number(sizeValue)
  const spec: SplitSpec | null = useMemo(() => {
    if (mode === 'ranges') {
      const r = parsePageRanges(ranges.text, n)
      return r.ok ? { by: 'ranges', ranges: r.ranges } : null
    }
    if (mode === 'every') return Number.isInteger(everyN) && everyN >= 1 ? { by: 'every', pages: everyN } : null
    if (mode === 'size') {
      const bytes = Math.round(sizeN * (sizeUnit === 'MB' ? 1024 * 1024 : 1024))
      return Number.isFinite(bytes) && bytes >= 10 * 1024 ? { by: 'size', maxBytes: bytes } : null
    }
    return marks && marks !== 'loading' && marks.parts.length > 0 ? { by: 'bookmarks' } : null
  }, [mode, ranges.text, n, everyN, sizeN, sizeUnit, marks])

  const preview = useMemo((): string => {
    if (mode === 'ranges' && spec?.by === 'ranges') return `Creates ${plural(planByRanges(spec.ranges).parts.length, 'file')}.`
    if (mode === 'every' && spec?.by === 'every') return `Creates ${plural(planEveryN(n, spec.pages).parts.length, 'file')}.`
    if (mode === 'size' && spec?.by === 'size') return `Each file will be at most ${formatBytes(spec.maxBytes)}; pages are never cut in half.`
    return ''
  }, [mode, spec, n])

  const chooseFolder = async (): Promise<void> => {
    try {
      const f = await window.epdf.call<PickedFolder | null>('pages:pickFolder', {})
      if (f) setFolder(f)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const start = async (): Promise<void> => {
    if (!spec || !folder) return
    setError('')
    setStage('running')
    try {
      const bytes = await currentBytes(tab.docId)
      const job = startJob<SplitResult>('pages:split', { bytes, spec, folderToken: folder.token, baseName: stemOf(tab.name) })
      cancelRef.current = job.cancel
      const res = await job.promise
      setResult(res)
      setStage('done')
    } catch (err) {
      if (err instanceof JobCancelledError) notify('info', 'Splitting was cancelled. No files were kept.')
      else setError(errorMessage(err))
      setStage('setup')
    } finally {
      cancelRef.current = null
    }
  }

  const onClose = (): void => {
    if (stage === 'running') return // cancel with the Cancel button
    close()
  }

  if (stage === 'done' && result) {
    return (
      <Modal title="Split complete" onClose={onClose} wide>
        <p role="status" data-testid="split-summary" className="mb-2 text-sm">
          Created {plural(result.files.length, 'file')} in “{folder?.name}”.
        </p>
        <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-md border border-line text-sm" aria-label="Created files">
          {result.files.map((f) => (
            <li key={f.token} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="min-w-0 truncate" title={f.name}>
                {f.name}
              </span>
              <span className="shrink-0 text-ink-muted">
                {f.pages ? `pages ${f.pages}` : ''} · {formatBytes(f.size)}
                {f.oversized ? ' · over the size limit' : ''}
              </span>
            </li>
          ))}
        </ul>
        {result.warnings.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-sm text-ink-muted" aria-label="Notes">
            {result.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        <Footer>
          <button className="btn" onClick={() => void window.epdf.call('pages:reveal', { token: result.files[0]?.token ?? result.folderToken })}>
            Show in folder
          </button>
          <button className="btn-primary" onClick={close} autoFocus>
            Close
          </button>
        </Footer>
      </Modal>
    )
  }

  const running = stage === 'running'
  return (
    <Modal title="Split document" onClose={onClose} wide>
      <fieldset disabled={running}>
        <legend className="mb-1 text-sm font-medium">Split by</legend>
        <div className="space-y-2">
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="split-mode" checked={mode === 'ranges'} onChange={() => setMode('ranges')} autoFocus />
              Page ranges
            </label>
            {mode === 'ranges' && (
              <div className="ml-6 mt-1">
                <label className="sr-only" htmlFor="split-ranges">
                  Page ranges
                </label>
                <input id="split-ranges" className="field w-full" value={ranges.text} placeholder="1-3, 4-10, 11-" aria-invalid={!!ranges.error} aria-describedby="split-ranges-error" onChange={(e) => ranges.setText(e.target.value)} />
                <ErrorText id="split-ranges-error">{ranges.error}</ErrorText>
              </div>
            )}
          </div>
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="split-mode" checked={mode === 'every'} onChange={() => setMode('every')} />
              Every N pages
            </label>
            {mode === 'every' && (
              <div className="ml-6 mt-1 flex items-center gap-2 text-sm">
                <label htmlFor="split-every">Pages per file</label>
                <input id="split-every" className="field w-20" inputMode="numeric" value={every} aria-invalid={!spec} onChange={(e) => setEvery(e.target.value.replace(/[^0-9]/g, ''))} />
              </div>
            )}
          </div>
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="split-mode" checked={mode === 'size'} onChange={() => setMode('size')} />
              Maximum file size
            </label>
            {mode === 'size' && (
              <div className="ml-6 mt-1 flex items-center gap-2 text-sm">
                <label htmlFor="split-size">Largest file</label>
                <input id="split-size" className="field w-24" inputMode="decimal" value={sizeValue} aria-invalid={!spec} onChange={(e) => setSizeValue(e.target.value.replace(/[^0-9.]/g, ''))} />
                <label className="sr-only" htmlFor="split-unit">
                  Unit
                </label>
                <select id="split-unit" className="field" value={sizeUnit} onChange={(e) => setSizeUnit(e.target.value as 'MB' | 'KB')}>
                  <option value="MB">MB</option>
                  <option value="KB">KB</option>
                </select>
              </div>
            )}
          </div>
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="split-mode" checked={mode === 'bookmarks'} onChange={() => setMode('bookmarks')} />
              Top-level bookmarks
            </label>
            {mode === 'bookmarks' && (
              <div className="ml-6 mt-1 text-sm" data-testid="split-bookmarks">
                {marks === 'loading' || marks === null ? (
                  <p role="status">Reading bookmarks…</p>
                ) : (
                  <>
                    {marks.parts.length > 0 && (
                      <p>
                        Creates {plural(marks.parts.length, 'file')}: {marks.parts.slice(0, 6).map((p) => p.label).join(', ')}
                        {marks.parts.length > 6 ? '…' : ''}
                      </p>
                    )}
                    {marks.warnings.map((w) => (
                      <p key={w} className="text-ink-muted">
                        {w}
                      </p>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </fieldset>
      {preview && <p className="mt-3 text-sm text-ink-muted">{preview}</p>}

      <div className="mt-4 flex items-center gap-3">
        <button className="btn" disabled={running} onClick={() => void chooseFolder()}>
          Choose folder…
        </button>
        <span className="min-w-0 truncate text-sm text-ink-muted" data-testid="split-folder">
          {folder ? folder.name : 'No folder chosen'}
        </span>
      </div>
      <p className="mt-1 text-xs text-ink-muted">Existing files are never overwritten; new files get a number if a name is taken.</p>
      <ErrorText>{error}</ErrorText>
      {running && (
        <p role="status" className="mt-3 text-sm">
          Splitting… you can follow the progress in the jobs panel.
        </p>
      )}
      <Footer>
        {running ? (
          <button className="btn" onClick={() => cancelRef.current?.()}>
            Cancel splitting
          </button>
        ) : (
          <>
            <button className="btn" onClick={close}>
              Cancel
            </button>
            <button className="btn-primary" disabled={!spec || !folder} onClick={() => void start()}>
              Split
            </button>
          </>
        )}
      </Footer>
    </Modal>
  )
}

// ---- host ------------------------------------------------------------------------------------------------------

export function PageDialogs(): JSX.Element | null {
  const { kind, docId, preset, close } = usePageDialog()
  const tab = useTabs((s) => s.tabs.find((t) => t.docId === docId))
  useEffect(() => {
    if (kind && !tab) close()
  }, [kind, tab, close])
  if (!kind || !tab) return null
  const props = { tab, preset, close }
  // `key` resets the dialog's state whenever it is opened for another document or kind.
  switch (kind) {
    case 'insert':
      return <InsertDialog key={`${docId}-insert`} {...props} />
    case 'blank':
      return <BlankDialog key={`${docId}-blank`} {...props} />
    case 'extract':
      return <ExtractDialog key={`${docId}-extract`} {...props} />
    case 'delete':
      return <DeleteDialog key={`${docId}-delete`} {...props} />
    case 'rotate':
      return <RotateDialog key={`${docId}-rotate`} {...props} />
    case 'split':
      return <SplitDialog key={`${docId}-split`} tab={tab} close={close} />
  }
}
