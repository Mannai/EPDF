import { useCallback, useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import type { PhoneStartResult } from '@shared/features/scan'
import { qrMatrix, qrSvgPath } from '@shared/features/scan/qr'
import { errorMessage } from '../../state/notify'
import { useScan } from './store'
import { Field, Spinner, plural } from './ui'

/** Source 3: a phone on the same network sends photos to a temporary link (QR code). */

export const usePhone = create<{ expired: boolean; received: number }>(() => ({ expired: false, received: 0 }))

type State = { kind: 'starting' } | { kind: 'live'; info: PhoneStartResult } | { kind: 'error'; message: string }

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function PhonePanel(): JSX.Element {
  const sessionId = useScan((s) => s.sessionId)
  const [state, setState] = useState<State>({ kind: 'starting' })
  const [selected, setSelected] = useState(0)
  const [now, setNow] = useState(Date.now())
  const expired = usePhone((s) => s.expired)
  const received = usePhone((s) => s.received)

  const start = useCallback(async (): Promise<void> => {
    setState({ kind: 'starting' })
    usePhone.setState({ expired: false, received: 0 })
    try {
      const info = await window.epdf.call<PhoneStartResult>('scan:phoneStart', { sessionId })
      setSelected(0)
      setState({ kind: 'live', info })
    } catch (err) {
      setState({ kind: 'error', message: errorMessage(err) })
    }
  }, [sessionId])

  useEffect(() => {
    void start()
    // the link is only valid while this panel is open
    return () => void window.epdf.call('scan:phoneStop', { sessionId }).catch(() => undefined)
  }, [start, sessionId])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const endpoint = state.kind === 'live' ? state.info.endpoints[selected] : undefined
  const qr = useMemo(() => (endpoint ? qrSvgPath(qrMatrix(endpoint.url)) : null), [endpoint])
  const remaining = state.kind === 'live' ? state.info.expiresAt - now : 0
  const over = expired || (state.kind === 'live' && remaining <= 0)

  if (state.kind === 'starting') return <Spinner label="Opening a temporary link for your phone…" />
  if (state.kind === 'error') {
    return (
      <div role="alert" className="rounded-md border border-red-500 p-3 text-sm" data-testid="phone-error">
        <p className="text-red-700 dark:text-red-300">{state.message}</p>
        <button type="button" className="btn mt-2" onClick={() => void start()}>
          Try again
        </button>
      </div>
    )
  }

  return (
    <div data-testid="phone-panel" className="grid gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
      <div>
        {qr && endpoint && !over ? (
          <svg role="img" aria-label={`QR code for ${endpoint.url}`} viewBox={`0 0 ${qr.size} ${qr.size}`} className="h-56 w-56 rounded-md border border-line" shapeRendering="crispEdges" data-testid="phone-qr">
            <rect width={qr.size} height={qr.size} fill="#ffffff" />
            <path d={qr.d} fill="#000000" />
          </svg>
        ) : (
          <div className="flex h-56 w-56 items-center justify-center rounded-md border border-dashed border-line p-3 text-center text-sm text-ink-muted" data-testid="phone-expired">
            This link has expired.
          </div>
        )}
        <p className="mt-2 text-sm text-ink-muted" data-testid="phone-timer">
          {over ? 'Not active.' : `Works for ${mmss(remaining)} more, or until you leave this step.`}
        </p>
      </div>
      <div className="min-w-0">
        <ol className="mb-3 list-decimal pl-5 text-sm">
          <li>Connect your phone to the same Wi-Fi network as this computer.</li>
          <li>Point the phone’s camera at the code and open the link.</li>
          <li>Take photos of your pages, or choose them from the gallery. They appear here as soon as they are sent.</li>
        </ol>
        {state.info.endpoints.length > 1 && (
          <Field label="Network address" hint="Several networks were found. Choose the one your phone is on (usually Wi-Fi).">
            {(id) => (
              <select id={id} className="field w-full" value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
                {state.info.endpoints.map((e, i) => (
                  <option key={e.address} value={i}>
                    {e.address} ({e.interfaceName}){e.likelyVirtual ? ' - probably a virtual network' : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {endpoint && (
          <p className="mb-2 text-sm">
            Or type this address into the phone’s browser: <code className="select-text break-all rounded bg-surface-alt px-1" data-testid="phone-url">{endpoint.url}</code>
          </p>
        )}
        {endpoint?.likelyVirtual && <p className="mb-2 text-sm text-ink-muted">This looks like a virtual network (WSL, VPN or similar). Phones usually cannot reach those.</p>}
        <p role="note" className="mb-2 rounded-md border border-line bg-surface-alt p-2 text-sm" data-testid="phone-warning">
          This link is not encrypted (plain http on your local network). Anyone on the same Wi-Fi who has the link could see the photos while they are sent. Use it only on a network you trust; the link stops working when you leave this step.
        </p>
        {state.info.warnings.length > 0 && (
          <ul className="mb-2 list-disc pl-5 text-sm text-ink-muted">
            {state.info.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        <p className="mb-2 text-sm text-ink-muted">If the phone cannot open the link: check that both devices are on the same network (guest Wi-Fi often blocks this) and that the firewall allows Epdf on private networks.</p>
        <div className="flex flex-wrap items-center gap-3">
          <span role="status" className="text-sm" data-testid="phone-received">
            {received === 0 ? 'Waiting for photos…' : `${plural(received, 'photo')} received.`}
          </span>
          <button type="button" className="btn" onClick={() => void start()} data-testid="phone-renew">
            {over ? 'Get a new code' : 'New code'}
          </button>
        </div>
      </div>
    </div>
  )
}
