import { useCallback, useEffect, useRef, useState } from 'react'
import type { ColorMode, PaperSource, ScanEnvironment, ScannerCaps, ScannerDevice } from '@shared/features/scan'
import { JobCancelledError, startJob } from '../../state/jobs'
import { errorMessage } from '../../state/notify'
import { announce } from './pages'
import { useScan } from './store'
import { Field, Spinner, plural } from './ui'

/** Source 1: a scanner (Windows WIA, macOS helper, or the test scanner). */

interface Prefs {
  dpi: number
  colorMode: ColorMode
  source: PaperSource
  duplex: boolean
  deviceId: string
}
const PREF_KEY = 'epdf.scan.scanner'
const loadPrefs = (): Partial<Prefs> => {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as Partial<Prefs>
  } catch {
    return {}
  }
}
const savePrefs = (p: Prefs): void => {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p))
  } catch {
    /* storage unavailable: the choices just are not remembered */
  }
}

const COLOR_LABEL: Record<ColorMode, string> = { color: 'Colour', gray: 'Grayscale', bw: 'Black & white' }
const SOURCE_LABEL: Record<PaperSource, string> = { flatbed: 'Flatbed (glass)', feeder: 'Document feeder' }

type Status = { kind: 'idle' } | { kind: 'scanning'; message: string } | { kind: 'done'; pages: number } | { kind: 'error'; message: string }

export function ScannerPanel(): JSX.Element {
  const sessionId = useScan((s) => s.sessionId)
  const pageCount = useScan((s) => s.pages.length)
  const [env, setEnv] = useState<ScanEnvironment | null>(null)
  const [devices, setDevices] = useState<ScannerDevice[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [caps, setCaps] = useState<ScannerCaps | null>(null)
  const saved = useRef(loadPrefs()).current
  const [deviceId, setDeviceId] = useState(saved.deviceId ?? '')
  const [dpi, setDpi] = useState(saved.dpi ?? 200)
  const [colorMode, setColorMode] = useState<ColorMode>(saved.colorMode ?? 'color')
  const [source, setSource] = useState<PaperSource>(saved.source ?? 'flatbed')
  const [duplex, setDuplex] = useState(saved.duplex ?? false)
  const [maxPages, setMaxPages] = useState(50)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const cancelRef = useRef<(() => void) | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setDevices(null)
    setLoadError(null)
    try {
      const e = await window.epdf.call<ScanEnvironment>('scan:environment', {})
      if (!mounted.current) return
      setEnv(e)
      if (e.backend === 'none') return void setDevices([])
      const list = await window.epdf.call<ScannerDevice[]>('scan:devices', {})
      if (!mounted.current) return
      setDevices(list)
      setDeviceId((cur) => (list.some((d) => d.id === cur) ? cur : (list[0]?.id ?? '')))
    } catch (err) {
      if (!mounted.current) return
      setLoadError(errorMessage(err))
      setDevices([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!deviceId) return void setCaps(null)
    let live = true
    window.epdf
      .call<ScannerCaps>('scan:capabilities', { deviceId })
      .then((c) => {
        if (!live) return
        setCaps(c)
        setDpi((cur) => (c.resolutions.includes(cur) ? cur : (c.resolutions.find((r) => r >= 200) ?? c.resolutions[c.resolutions.length - 1] ?? cur)))
        setColorMode((cur) => (c.colorModes.includes(cur) ? cur : (c.colorModes[0] ?? cur)))
        setSource((cur) => (c.sources.includes(cur) ? cur : (c.sources[0] ?? cur)))
        if (!c.duplex) setDuplex(false)
      })
      .catch((err) => {
        if (live) setLoadError(errorMessage(err))
      })
    return () => {
      live = false
    }
  }, [deviceId])

  const scanning = status.kind === 'scanning'

  const scan = (): void => {
    if (!deviceId || scanning) return
    savePrefs({ dpi, colorMode, source, duplex, deviceId })
    setStatus({ kind: 'scanning', message: 'Contacting the scanner…' })
    announce('Scanning started.')
    const before = useScan.getState().pages.length
    const job = startJob<{ pages: number }>('scan:acquire', { sessionId, deviceId, dpi, colorMode, source, duplex: source === 'feeder' && duplex, maxPages: source === 'feeder' ? maxPages : 1 })
    cancelRef.current = job.cancel
    job.promise
      .then((r) => {
        cancelRef.current = null
        if (!mounted.current) return
        setStatus({ kind: 'done', pages: r.pages })
        announce(`Scanning finished: ${plural(r.pages, 'page')} received.`)
      })
      .catch((err) => {
        cancelRef.current = null
        if (!mounted.current) return
        if (err instanceof JobCancelledError) {
          const got = useScan.getState().pages.length - before
          setStatus({ kind: 'error', message: got > 0 ? `Scanning was cancelled after ${plural(got, 'page')}.` : 'Scanning was cancelled.' })
        } else setStatus({ kind: 'error', message: errorMessage(err) })
      })
  }

  // leaving the panel (other tab, next step, dialog closed) stops a scan in progress
  useEffect(() => () => cancelRef.current?.(), [])

  if (env && env.backend === 'none') {
    return (
      <p role="status" className="rounded-md border border-line bg-surface-alt p-3 text-sm" data-testid="scanner-unavailable">
        {env.message ?? 'Scanning from a scanner is not available on this computer.'}
      </p>
    )
  }

  return (
    <div data-testid="scanner-panel">
      {devices === null && <Spinner label="Looking for scanners…" />}
      {devices !== null && devices.length === 0 && !loadError && (
        <p role="status" className="mb-3 rounded-md border border-line bg-surface-alt p-3 text-sm" data-testid="no-scanners">
          No scanner was found. Make sure it is switched on and connected (USB or the same network), then choose Refresh.
        </p>
      )}
      {loadError && (
        <p role="alert" className="mb-3 rounded-md border border-red-500 p-3 text-sm text-red-700 dark:text-red-300">
          {loadError}
        </p>
      )}
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="Scanner">
          {(id) => (
            <div className="flex gap-2">
              <select id={id} className="field min-w-0 flex-1" value={deviceId} disabled={!devices?.length || scanning} onChange={(e) => setDeviceId(e.target.value)}>
                {(devices ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <button type="button" className="btn" onClick={() => void refresh()} disabled={scanning}>
                Refresh
              </button>
            </div>
          )}
        </Field>
        <Field label="Source">
          {(id) => (
            <select id={id} className="field w-full" value={source} disabled={!caps || scanning} onChange={(e) => setSource(e.target.value as PaperSource)}>
              {(caps?.sources ?? ['flatbed']).map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABEL[s]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Resolution">
          {(id) => (
            <select id={id} className="field w-full" value={dpi} disabled={!caps || scanning} onChange={(e) => setDpi(Number(e.target.value))}>
              {(caps?.resolutions ?? [dpi]).map((r) => (
                <option key={r} value={r}>
                  {r} dpi
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Colour">
          {(id) => (
            <select id={id} className="field w-full" value={colorMode} disabled={!caps || scanning} onChange={(e) => setColorMode(e.target.value as ColorMode)}>
              {(caps?.colorModes ?? ['color']).map((m) => (
                <option key={m} value={m}>
                  {COLOR_LABEL[m]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {source === 'feeder' && (
          <>
            <Field label="Most pages to scan">
              {(id) => <input id={id} type="number" min={1} max={500} className="field w-full" value={maxPages} disabled={scanning} onChange={(e) => setMaxPages(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} />}
            </Field>
            {caps?.duplex && (
              <label className="mb-3 flex items-center gap-2 self-end pb-2">
                <input type="checkbox" className="accent-accent" checked={duplex} disabled={scanning} onChange={(e) => setDuplex(e.target.checked)} />
                Scan both sides (duplex)
              </label>
            )}
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" onClick={scan} disabled={!deviceId || scanning} data-testid="scan-go">
          {pageCount > 0 ? 'Scan another page' : 'Scan'}
        </button>
        {scanning && (
          <>
            <Spinner label={status.message} />
            <button type="button" className="btn" onClick={() => cancelRef.current?.()}>
              Cancel scanning
            </button>
          </>
        )}
        {status.kind === 'done' && (
          <span role="status" className="text-sm text-ink-muted" data-testid="scan-done">
            {status.pages === 1 ? 'Scanned 1 page.' : `Scanned ${status.pages} pages.`}
          </span>
        )}
      </div>
      {status.kind === 'error' && (
        <p role="alert" className="mt-3 rounded-md border border-red-500 p-3 text-sm text-red-700 dark:text-red-300" data-testid="scan-error">
          {status.message}
        </p>
      )}
      {env?.stub && <p className="mt-3 text-xs text-ink-muted">Test scanner: pictures come from the folder set in EPDF_SCANNER_STUB.</p>}
    </div>
  )
}
