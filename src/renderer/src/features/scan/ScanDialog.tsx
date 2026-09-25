import { useEffect, useRef } from 'react'
import type { PhoneImageEvent, PhoneStatusEvent, ScanPageEvent } from '@shared/features/scan'
import { askConfirm } from '../../state/confirm'
import { PageEditor } from './PageEditor'
import { PageStrip } from './PageStrip'
import { PhonePanel, usePhone } from './PhonePanel'
import { SaveStep } from './SaveStep'
import { ScannerPanel } from './ScannerPanel'
import { WebcamPanel } from './WebcamPanel'
import { addImage, announce, closeScanDialog, selectPage } from './pages'
import { useScan, type ScanSource, type ScanStep } from './store'
import { plural } from './ui'

/**
 * The Scan to PDF dialog: three steps (Capture, Adjust, Save) in one window. It mirrors the accessibility behaviour of
 * `components/Modal` (labelled dialog, focus trap, Escape, focus return) but is wider than Modal's fixed width, which a
 * page editor needs.
 */

const TABS: { id: ScanSource; label: string }[] = [
  { id: 'scanner', label: 'Scanner' },
  { id: 'webcam', label: 'Webcam' },
  { id: 'phone', label: 'Phone' }
]
const STEPS: { id: ScanStep; label: string }[] = [
  { id: 'capture', label: 'Capture' },
  { id: 'adjust', label: 'Adjust' },
  { id: 'save', label: 'Save' }
]
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Hooks main's push events (pictures from the scanner and the phone) into the page list. */
function useScanEvents(): void {
  useEffect(() => {
    const api = window.epdf
    const offs = [
      api.onFeature('scan:page', (p) => {
        const e = p as ScanPageEvent
        const s = useScan.getState()
        if (!s.open || e.sessionId !== s.sessionId) return
        addImage(new Blob([e.bytes as Uint8Array<ArrayBuffer>], { type: e.mime }), 'scanner', e.dpi)
      }),
      api.onFeature('scan:phoneImage', (p) => {
        const e = p as PhoneImageEvent
        const s = useScan.getState()
        if (!s.open || e.sessionId !== s.sessionId) return
        addImage(new Blob([e.bytes as Uint8Array<ArrayBuffer>], { type: e.mime }), 'phone')
        usePhone.setState((x) => ({ received: x.received + 1 }))
        announce('Photo received from your phone.')
      }),
      api.onFeature('scan:phoneStatus', (p) => {
        const e = p as PhoneStatusEvent
        if (e.sessionId === useScan.getState().sessionId && e.state === 'expired') usePhone.setState({ expired: true })
      })
    ]
    return () => offs.forEach((off) => off())
  }, [])
}

export async function requestClose(): Promise<void> {
  const s = useScan.getState()
  if (s.busy) return
  if (s.pages.length > 0) {
    const r = await askConfirm({
      title: 'Discard the scanned pages?',
      message: `You have ${plural(s.pages.length, 'page')} that ${s.pages.length === 1 ? 'has' : 'have'} not been saved. Closing the window discards ${s.pages.length === 1 ? 'it' : 'them'}.`,
      buttons: [
        { label: 'Discard', value: 'discard', variant: 'danger' },
        { label: 'Keep scanning', value: 'keep', variant: 'primary' }
      ],
      cancelValue: 'keep'
    })
    if (r !== 'discard') return
  }
  await closeScanDialog()
}

function goStep(step: ScanStep): void {
  useScan.setState({ step, error: null })
  if (step === 'adjust') {
    const s = useScan.getState()
    selectPage(s.selectedId && s.pages.some((p) => p.id === s.selectedId) ? s.selectedId : (s.pages[0]?.id ?? null))
  }
}

export function ScanDialogHost(): JSX.Element | null {
  const open = useScan((s) => s.open)
  useScanEvents()
  return open ? <ScanShell /> : null
}

function ScanShell(): JSX.Element {
  const step = useScan((s) => s.step)
  const tab = useScan((s) => s.tab)
  const pages = useScan((s) => s.pages)
  const busy = useScan((s) => s.busy)
  const said = useScan((s) => s.announce)
  const ref = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<Element | null>(document.activeElement)
  const ready = pages.filter((p) => p.state === 'ready').length

  const contentRef = useRef<HTMLDivElement>(null)
  const firstStep = useRef(true)

  useEffect(() => {
    const root = ref.current
    ;(root?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? root)?.focus()
    const prev = returnFocus.current as HTMLElement | null
    return () => prev?.focus?.()
  }, [])

  // The button that changed the step disappears: move focus to the new step so keyboard and screen reader users are not lost.
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false
      return
    }
    contentRef.current?.focus()
  }, [step])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      void requestClose()
    } else if (e.key === 'Tab' && ref.current) {
      const f = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
      if (!f.length) return
      const first = f[0]
      const last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  const onTabKey = (e: React.KeyboardEvent, i: number): void => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const next = TABS[(i + d + TABS.length) % TABS.length]
    useScan.setState({ tab: next.id })
    requestAnimationFrame(() => document.getElementById(`scan-tab-${next.id}`)?.focus())
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" onKeyDown={onKeyDown}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="scan-title" tabIndex={-1} className="flex w-full max-w-[74rem] flex-col rounded-lg border border-line bg-raised shadow-2xl" style={{ height: 'min(94vh, 54rem)' }} data-testid="scan-dialog">
        <header className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-line px-4 py-2">
          <h2 id="scan-title" className="text-base font-semibold">
            Scan to PDF
          </h2>
          <ol aria-label="Steps" className="flex flex-1 gap-3 text-sm">
            {STEPS.map((s, i) => (
              <li key={s.id} aria-current={s.id === step ? 'step' : undefined} className={s.id === step ? 'font-semibold text-ink' : 'text-ink-muted'}>
                {i + 1}. {s.label}
              </li>
            ))}
          </ol>
          <button type="button" className="btn" onClick={() => void requestClose()} disabled={!!busy} data-testid="scan-close">
            Close
          </button>
        </header>

        <div ref={contentRef} role="group" aria-label={`Step ${STEPS.findIndex((s) => s.id === step) + 1} of ${STEPS.length}: ${STEPS.find((s) => s.id === step)?.label}`} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto p-4 outline-none" data-testid="scan-step">
          {step === 'capture' && (
            <>
              <div role="tablist" aria-label="Where do the pages come from?" className="mb-3 flex gap-1 border-b border-line">
                {TABS.map((t, i) => (
                  <button
                    key={t.id}
                    id={`scan-tab-${t.id}`}
                    role="tab"
                    type="button"
                    aria-selected={tab === t.id}
                    aria-controls="scan-tabpanel"
                    tabIndex={tab === t.id ? 0 : -1}
                    onClick={() => useScan.setState({ tab: t.id })}
                    onKeyDown={(e) => onTabKey(e, i)}
                    className={`-mb-px rounded-t-md border-x border-t px-4 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent ${tab === t.id ? 'border-line bg-raised font-semibold' : 'border-transparent text-ink-muted hover:text-ink'}`}
                    data-testid={`tab-${t.id}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <div role="tabpanel" id="scan-tabpanel" aria-labelledby={`scan-tab-${tab}`} className="mb-4 min-h-[16rem]">
                {tab === 'scanner' && <ScannerPanel />}
                {tab === 'webcam' && <WebcamPanel />}
                {tab === 'phone' && <PhonePanel />}
              </div>
              <PageStrip />
            </>
          )}
          {step === 'adjust' && (
            <>
              <PageStrip showTools={false} />
              <div className="mt-3">
                <PageEditor />
              </div>
            </>
          )}
          {step === 'save' && <SaveStep />}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-line px-4 py-2">
          <span role="status" className="sr-only" data-testid="scan-announce">
            {said}
          </span>
          <div>
            {step !== 'capture' && (
              <button type="button" className="btn" onClick={() => goStep(step === 'save' ? 'adjust' : 'capture')} disabled={!!busy} data-testid="step-back">
                Back
              </button>
            )}
          </div>
          <div className="flex gap-2">
            {step === 'capture' && (
              <button type="button" className="btn-primary" onClick={() => goStep('adjust')} disabled={ready === 0} data-testid="step-next">
                Next: adjust pages
              </button>
            )}
            {step === 'adjust' && (
              <button type="button" className="btn-primary" onClick={() => goStep('save')} disabled={ready === 0} data-testid="step-next">
                Next: save
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
