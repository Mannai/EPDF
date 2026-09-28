import { useEffect, useMemo, useRef, useState } from 'react'
import { Advanced } from '../../components/Advanced'
import { Modal } from '../../components/Modal'
import { errorMessage, notify } from '../../state/notify'
import { useTabs } from '../../state/tabs'
import {
  GROUPS,
  HF_CHANNELS,
  MAX_PRESET_SOURCE_BYTES,
  defaultsFor,
  parseGroupSettings,
  type GroupSettings,
  type HeaderFooterSettings,
  type MarkGroup,
  type OverlaySettings,
  type PickedSource,
  type Preset
} from '@shared/features/headerfooter'
import { announce, applyAction, applyLabel, loadForDialog, removeAction, type LoadedForDialog } from './actions'
import { ErrorText } from './Fields'
import { HeaderFooterForm, OverlayForm, type SourceState } from './Forms'
import { selectPages } from './pdf/geometry'
import type { SourceInput } from './pdf/apply'
import { previewBytes, renderInto } from './preview'
import { GROUP_LABEL, GROUP_NOUN, useHfUi } from './store'

/**
 * The page-marks dialog: tabs for header & footer, Bates numbering, watermark and background; the settings; presets;
 * a live preview of a chosen page; Apply (one undo step, with progress and Cancel on long documents) and Remove.
 */

type SettingsMap = Record<MarkGroup, GroupSettings>
type Sources = Record<'watermark' | 'background', SourceState>

const PREVIEW_W = 216
const PREVIEW_H = 280

const toBase64 = (b: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}
const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const sniff = (b: Uint8Array): 'png' | 'jpeg' | 'pdf' | null =>
  b[0] === 0x89 && b[1] === 0x50 ? 'png' : b[0] === 0xff && b[1] === 0xd8 ? 'jpeg' : new TextDecoder('latin1').decode(b.subarray(0, 1024)).includes('%PDF-') ? 'pdf' : null

export function PageMarksDialog(): JSX.Element | null {
  const open = useHfUi((s) => s.open)
  if (!open) return null
  return <DialogBody key={`${open.docId}:${open.group}`} docId={open.docId} initialGroup={open.group} initialPage={open.page} />
}

function DialogBody({ docId, initialGroup, initialPage }: { docId: string; initialGroup: MarkGroup; initialPage: number }): JSX.Element | null {
  const close = useHfUi((s) => s.close)
  const tab = useTabs((s) => s.tabs.find((t) => t.docId === docId))
  const [loaded, setLoaded] = useState<LoadedForDialog | null>(null)
  const [loadError, setLoadError] = useState('')
  const [group, setGroup] = useState<MarkGroup>(initialGroup)
  const [settings, setSettings] = useState<SettingsMap | null>(null)
  const [sources, setSources] = useState<Sources>({ watermark: null, background: null })
  const [modes, setModes] = useState<Record<MarkGroup, 'replace' | 'add'>>({ headerfooter: 'replace', bates: 'replace', watermark: 'replace', background: 'replace' })
  const [previewPage, setPreviewPage] = useState(String(initialPage))
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState('')
  const cancelled = useRef(false)

  // Load the document (unlocking a protected one) and what it already carries.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const l = await loadForDialog(docId)
        if (!alive) return
        if (!l) {
          close()
          return
        }
        const lasts = await Promise.all(GROUPS.map((g) => window.epdf.call<unknown>(HF_CHANNELS.getLast, { group: g }).catch(() => null)))
        if (!alive) return
        const map = {} as SettingsMap
        const src: Sources = { watermark: null, background: null }
        GROUPS.forEach((g, i) => {
          const existing = l.summary[g].settings
          map[g] = existing ?? parseGroupSettings(g, lasts[i]) ?? defaultsFor(g)
          if ((g === 'watermark' || g === 'background') && existing && l.summary[g].source) {
            const s = existing.settings as OverlaySettings
            if (s.source.kind === 'image' || s.source.kind === 'pdf') src[g] = { kind: 'existing', name: s.source.name }
          }
        })
        setSettings(map)
        setSources(src)
        setLoaded(l)
      } catch (err) {
        if (alive) setLoadError(`The document could not be read: ${errorMessage(err)}`)
      }
    })()
    return () => {
      alive = false
    }
  }, [docId, close])

  const numPages = loaded?.pdf.getPageCount() ?? tab?.numPages ?? 1
  const gs = settings?.[group]
  const rangeCheck = useMemo(() => (gs ? selectPages(numPages, gs.settings.pages) : null), [gs, numPages])
  const rangeError = rangeCheck && !rangeCheck.ok ? rangeCheck.error : ''
  const summary = loaded?.summary[group]
  const updating = !!summary && summary.pages > 0
  const mode = modes[group]

  const sourceInput = (g: MarkGroup): SourceInput | undefined => {
    if (g !== 'watermark' && g !== 'background') return undefined
    const s = sources[g]
    if (!s) return undefined
    if (s.kind === 'file') return { bytes: s.bytes, kind: s.fileKind }
    const ref = loaded?.summary[g].source
    return ref ? { ref } : undefined
  }

  const problem = ((): string => {
    if (!gs) return ''
    if (rangeError) return rangeError
    if (gs.group === 'headerfooter' || gs.group === 'bates') {
      const s = gs.settings as HeaderFooterSettings
      return Object.values(s.slots).some((t) => t.trim()) ? '' : 'Type the text of at least one header or footer.'
    }
    const s = gs.settings as OverlaySettings
    if (!s.print && !s.screen) return 'Choose to show it on screen, when printing, or both.'
    if (s.source.kind === 'text' && !s.source.text.trim()) return 'Type the watermark text.'
    if ((s.source.kind === 'image' || s.source.kind === 'pdf') && !sourceInput(gs.group)) return s.source.kind === 'image' ? 'Choose a picture.' : 'Choose a PDF.'
    const cur = sources[gs.group as 'watermark' | 'background']
    if (s.source.kind === 'image' && cur?.kind === 'file' && cur.fileKind === 'pdf') return 'Choose a picture (PNG or JPEG).'
    if (s.source.kind === 'pdf' && cur?.kind === 'file' && cur.fileKind !== 'pdf') return 'Choose a PDF.'
    return ''
  })()

  // ---------------------------------------------------------------- preview
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [previewNote, setPreviewNote] = useState('')
  const [previewState, setPreviewState] = useState<'idle' | 'busy' | 'ready' | 'error'>('idle')
  const seq = useRef(0)
  const pageNo = Number(previewPage)
  const pageOk = Number.isInteger(pageNo) && pageNo >= 1 && pageNo <= numPages
  useEffect(() => {
    if (!loaded || !gs || !pageOk) return
    const my = ++seq.current
    const timer = setTimeout(() => {
      void (async () => {
        setPreviewState('busy')
        const inRange = rangeCheck?.ok ? rangeCheck.pages.includes(pageNo - 1) : false
        const withMarks = inRange && !problem
        try {
          const bytes = await previewBytes({ base: loaded.pdf, pageIndex: pageNo - 1, gs, mode, source: sourceInput(group), fileName: tab?.name ?? 'document.pdf', withMarks })
          if (my !== seq.current || !canvasRef.current) return
          await renderInto(canvasRef.current, bytes, PREVIEW_W, PREVIEW_H)
          if (my !== seq.current) return
          setPreviewNote(withMarks ? '' : !inRange ? `Page ${pageNo} is not in the page range: nothing is added to it.` : problem)
          setPreviewState('ready')
        } catch (err) {
          if (my !== seq.current) return
          setPreviewNote(`The preview could not be drawn: ${errorMessage(err)}`)
          setPreviewState('error')
        }
      })()
    }, 220)
    return () => clearTimeout(timer)
  }, [loaded, gs, pageNo, pageOk, mode, sources, group, problem])

  if (loadError) {
    return (
      <Modal title="Page marks" onClose={close}>
        <ErrorText>{loadError}</ErrorText>
        <div className="mt-4 flex justify-end">
          <button className="btn" onClick={close}>
            Close
          </button>
        </div>
      </Modal>
    )
  }

  const update = (next: GroupSettings): void => setSettings((m) => (m ? { ...m, [next.group]: next } : m))

  const pick = async (g: 'watermark' | 'background', kind: 'image' | 'pdf'): Promise<void> => {
    setError('')
    try {
      const p = await window.epdf.call<PickedSource | null>(HF_CHANNELS.pickSource, { kind })
      if (!p) return
      setSources((s) => ({ ...s, [g]: { kind: 'file', name: p.name, fileKind: p.kind, bytes: p.bytes } }))
      const cur = settings![g].settings as OverlaySettings
      update({ group: g, settings: { ...cur, source: kind === 'image' ? { kind: 'image', name: p.name } : { kind: 'pdf', name: p.name, page: cur.source.kind === 'pdf' ? cur.source.page : 1 } } } as GroupSettings)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const apply = async (): Promise<void> => {
    if (!gs || problem || busy) return
    setError('')
    cancelled.current = false
    const total = rangeCheck?.ok ? rangeCheck.pages.length : numPages
    setBusy({ done: 0, total })
    let last = 0
    const r = await applyAction({
      docId,
      gs,
      mode: summary && summary.pages + summary.foreignPages > 0 ? mode : 'add',
      source: sourceInput(group),
      fileName: tab?.name ?? 'document.pdf',
      label: applyLabel(group, mode, updating),
      isCancelled: () => cancelled.current,
      onProgress: (done, t) => {
        const now = performance.now()
        if (done === t || now - last > 120) {
          last = now
          setBusy({ done, total: t })
        }
      }
    })
    setBusy(null)
    if (!r.ok) {
      if (r.cancelled) announce(r.message)
      setError(r.message)
      return
    }
    const msg = `${GROUP_LABEL[group]} ${updating && mode === 'replace' ? 'updated' : 'added'} on ${r.pages} page${r.pages === 1 ? '' : 's'}.`
    notify('success', msg)
    announce(msg)
    if (r.missing.length) notify('info', `Some characters could not be drawn with the bundled fonts: ${r.missing.slice(0, 12).join(' ')}`)
    close()
  }

  const remove = async (): Promise<void> => {
    if (busy) return
    setBusy({ done: 0, total: 0 })
    const ok = await removeAction(docId, group)
    setBusy(null)
    if (ok) close()
  }

  const onClose = (): void => {
    if (busy) {
      cancelled.current = true
      return
    }
    close()
  }

  return (
    <Modal title="Headers, footers and watermarks" description="Add text, page numbers or a watermark to the pages of this document." onClose={onClose} size="l">
      <div data-testid="hf-dialog" data-ready={loaded ? 'true' : 'false'} className="flex min-h-0 flex-1 flex-col">
        <Tabs group={group} onChange={setGroup} disabled={!!busy} />
        {!loaded || !settings || !gs ? (
          <p className="py-8 text-center text-sm text-ink-muted" role="status">
            Reading the document…
          </p>
        ) : (
          <div role="tabpanel" id={`hf-panel-${group}`} aria-labelledby={`hf-tab-${group}`} className="-me-6 flex min-h-0 flex-1">
            <div className="min-w-0 flex-1 overflow-y-auto py-4 pe-6">
              <ExistingNotice group={group} summary={loaded.summary[group]} mode={mode} onMode={(m) => setModes((s) => ({ ...s, [group]: m }))} />
              {gs.group === 'headerfooter' || gs.group === 'bates' ? (
                <HeaderFooterForm key={group} value={gs.settings} bates={gs.group === 'bates'} rangeError={rangeError} onChange={(s) => update({ group: gs.group, settings: s } as GroupSettings)} />
              ) : (
                <OverlayForm
                  key={group}
                  group={gs.group}
                  value={gs.settings as OverlaySettings}
                  source={sources[gs.group]}
                  onPick={(k) => void pick(gs.group as 'watermark' | 'background', k)}
                  rangeError={rangeError}
                  onChange={(s) => update({ group: gs.group, settings: s } as GroupSettings)}
                />
              )}
              <PresetBar
                group={group}
                gs={gs}
                source={group === 'watermark' || group === 'background' ? sources[group] : null}
                onLoad={(p) => {
                  const parsed = parseGroupSettings(p.group, p.settings)
                  if (!parsed) return
                  update(parsed)
                  if ((p.group === 'watermark' || p.group === 'background') && p.sourceData) {
                    const bytes = fromBase64(p.sourceData)
                    const k = sniff(bytes)
                    const s = parsed.settings as OverlaySettings
                    if (k) setSources((cur) => ({ ...cur, [p.group]: { kind: 'file', name: s.source.kind === 'image' || s.source.kind === 'pdf' ? s.source.name : 'preset', fileKind: k, bytes } }))
                  }
                  announce(`Preset “${p.name}” loaded.`)
                }}
              />
            </div>
            <aside aria-label="Preview" className="flex w-[280px] shrink-0 flex-col items-center gap-2.5 border-s border-line bg-surface-alt px-5 py-4">
              <div className="flex w-full items-center justify-between gap-2">
                <span className="font-semibold">Preview</span>
                <span className="flex items-center gap-1 text-ink-muted">
                  <label htmlFor="hf-preview-page">Page</label>
                  <input id="hf-preview-page" aria-label="Preview page" className="field field-sm w-12 text-center" inputMode="numeric" value={previewPage} aria-invalid={!pageOk} onChange={(e) => setPreviewPage(e.target.value.replace(/[^0-9]/g, ''))} />
                  <span>of {numPages}</span>
                </span>
              </div>
              <div className="flex min-h-[17.5rem] w-full items-center justify-center">
                <canvas ref={canvasRef} data-testid="hf-preview" data-state={previewState} role="img" aria-label={`Preview of page ${pageNo} with the ${GROUP_LABEL[group].toLowerCase()}`} className="bg-white shadow-2" />
              </div>
              <p className="m-0 text-center text-caption text-ink-muted" aria-live="polite">
                {pageOk ? previewNote : `Enter a page from 1 to ${numPages}.`}
              </p>
            </aside>
          </div>
        )}
        <ErrorText>{error}</ErrorText>
        {problem && loaded && <p className="mt-2 text-xs text-ink-muted">{problem}</p>}
        {/* Windows 11 footer: the primary action first, buttons sharing the width; "Remove" stays at the start. */}
        <div className="dialog-footer -mx-6">
          {busy ? (
            <>
              <span role="status" aria-live="polite" className="me-auto" data-testid="hf-progress">
                {busy.total > 0 ? `Applying… page ${Math.min(busy.done + 1, busy.total)} of ${busy.total}` : 'Working…'}
              </span>
              <button className="btn" onClick={() => (cancelled.current = true)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              {summary && summary.pages + summary.foreignPages > 0 && (
                <button className="btn-ghost" onClick={() => void remove()}>
                  Remove {GROUP_NOUN[group]}
                </button>
              )}
              <button className="btn-primary" disabled={!loaded || !!problem} onClick={() => void apply()}>
                {updating && mode === 'replace' ? 'Update' : 'Apply'}
              </button>
              <button className="btn" onClick={close}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

function Tabs({ group, onChange, disabled }: { group: MarkGroup; onChange(g: MarkGroup): void; disabled: boolean }): JSX.Element {
  const refs = useRef(new Map<MarkGroup, HTMLButtonElement>())
  const onKey = (e: React.KeyboardEvent): void => {
    const i = GROUPS.indexOf(group)
    let next = -1
    if (e.key === 'ArrowRight') next = (i + 1) % GROUPS.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + GROUPS.length) % GROUPS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = GROUPS.length - 1
    if (next < 0) return
    e.preventDefault()
    onChange(GROUPS[next]!)
    refs.current.get(GROUPS[next]!)?.focus()
  }
  return (
    <div role="tablist" aria-label="What to add" className="tabs" onKeyDown={onKey}>
      {GROUPS.map((g) => (
        <button
          key={g}
          id={`hf-tab-${g}`}
          ref={(el) => {
            if (el) refs.current.set(g, el)
          }}
          role="tab"
          type="button"
          aria-selected={g === group}
          aria-controls={`hf-panel-${g}`}
          tabIndex={g === group ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(g)}
          className="tab"
        >
          {GROUP_LABEL[g]}
        </button>
      ))}
    </div>
  )
}

function ExistingNotice({ group, summary, mode, onMode }: { group: MarkGroup; summary: LoadedForDialog['summary'][MarkGroup]; mode: 'replace' | 'add'; onMode(m: 'replace' | 'add'): void }): JSX.Element | null {
  if (summary.pages === 0 && summary.foreignPages === 0) return null
  const noun = GROUP_NOUN[group]
  return (
    <div className="mb-2 rounded-md border border-line bg-surface-alt p-2 text-sm" data-testid="hf-existing">
      {summary.pages > 0 && (
        <p>
          This document already has {noun} added by Epdf on {summary.pages} page{summary.pages === 1 ? '' : 's'}; their settings are shown below.
        </p>
      )}
      {summary.foreignPages > 0 && (
        <p>
          {summary.foreignPages} page{summary.foreignPages === 1 ? ' has' : 's have'} {noun} made by other software.{' '}
          {group !== 'bates' ? 'Replacing removes them too.' : ''}
        </p>
      )}
      {(summary.pages > 0 || group !== 'bates') && (
        <div role="radiogroup" aria-label="Existing marks" className="mt-1 flex flex-wrap gap-3">
          <label className="flex items-center gap-1">
            <input type="radio" name={`hf-mode-${group}`} checked={mode === 'replace'} onChange={() => onMode('replace')} className="h-4 w-4 accent-[rgb(var(--c-accent))]" />
            Replace them (update)
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" name={`hf-mode-${group}`} checked={mode === 'add'} onChange={() => onMode('add')} className="h-4 w-4 accent-[rgb(var(--c-accent))]" />
            Keep them and add another
          </label>
        </div>
      )}
    </div>
  )
}

function PresetBar({ group, gs, source, onLoad }: { group: MarkGroup; gs: GroupSettings; source: SourceState; onLoad(p: Preset): void }): JSX.Element {
  const [presets, setPresets] = useState<Preset[]>([])
  const [chosen, setChosen] = useState('')
  const [name, setName] = useState('')
  const [msg, setMsg] = useState('')
  const refresh = async (): Promise<void> => {
    try {
      const list = await window.epdf.call<Preset[]>(HF_CHANNELS.listPresets, { group })
      setPresets(list)
      setChosen((c) => (list.some((p) => p.id === c) ? c : (list[0]?.id ?? '')))
    } catch {
      setPresets([])
    }
  }
  useEffect(() => {
    void refresh()
  }, [group])

  const save = async (): Promise<void> => {
    setMsg('')
    let sourceData: string | undefined
    if (source?.kind === 'file' && (gs.group === 'watermark' || gs.group === 'background')) {
      const k = (gs.settings as OverlaySettings).source.kind
      if (k === 'image' || k === 'pdf') {
        if (source.bytes.length > MAX_PRESET_SOURCE_BYTES) {
          setMsg(`The file is larger than ${MAX_PRESET_SOURCE_BYTES / (1024 * 1024)} MB; the preset keeps the settings but not the file.`)
        } else sourceData = toBase64(source.bytes)
      }
    }
    try {
      const p = await window.epdf.call<Preset>(HF_CHANNELS.savePreset, { name, group, settings: gs.settings, ...(sourceData ? { sourceData } : {}) })
      setName('')
      await refresh()
      setChosen(p.id)
      announce(`Preset “${p.name}” saved.`)
      setMsg((m) => m || `Saved “${p.name}”.`)
    } catch (err) {
      setMsg(errorMessage(err))
    }
  }
  const del = async (): Promise<void> => {
    const p = presets.find((x) => x.id === chosen)
    if (!p) return
    await window.epdf.call(HF_CHANNELS.deletePreset, { id: p.id }).catch(() => undefined)
    await refresh()
    setMsg(`Deleted “${p.name}”.`)
  }
  return (
    // Saved settings to reuse: folded away until wanted, like the other advanced options.
    <Advanced id="hf-presets" label="Presets" summary={presets.length ? `${presets.length} saved` : undefined}>
      <div data-testid="hf-presets">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col">
          <label htmlFor={`hf-preset-${group}`} className="text-xs text-ink-muted">
            Saved presets
          </label>
          <select id={`hf-preset-${group}`} className="field w-40" value={chosen} disabled={presets.length === 0} onChange={(e) => setChosen(e.target.value)}>
            {presets.length === 0 && <option value="">None yet</option>}
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="btn" disabled={!chosen} onClick={() => presets.find((p) => p.id === chosen) && onLoad(presets.find((p) => p.id === chosen)!)}>
          Load
        </button>
        <button type="button" className="btn" disabled={!chosen} onClick={() => void del()}>
          Delete
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="flex flex-col">
          <label htmlFor={`hf-preset-name-${group}`} className="text-xs text-ink-muted">
            Save these settings as
          </label>
          <input id={`hf-preset-name-${group}`} className="field w-40" dir="auto" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void save()} />
        </div>
        <button type="button" className="btn" disabled={!name.trim()} onClick={() => void save()}>
          Save preset
        </button>
      </div>
      {msg && (
        <p className="mt-1 text-xs text-ink-muted" role="status">
          {msg}
        </p>
      )}
      </div>
    </Advanced>
  )
}
