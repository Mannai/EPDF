import { useConfirm } from '../state/confirm'
import { cancelJob, useJobs } from '../state/jobs'
import { useToasts } from '../state/notify'
import { IconClose } from './Icons'
import { Modal } from './Modal'

export function Toasts(): JSX.Element {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className={`pointer-events-auto flex max-w-xl items-center gap-3 rounded-lg border px-4 py-2 shadow-lg ${
            t.kind === 'error'
              ? 'border-red-500/60 bg-raised text-ink'
              : t.kind === 'success'
                ? 'border-emerald-500/60 bg-raised text-ink'
                : 'border-line bg-raised text-ink'
          }`}
        >
          <span className={t.kind === 'error' ? 'font-semibold text-red-600 dark:text-red-400' : 'sr-only'}>
            {t.kind === 'error' ? 'Error' : t.kind === 'success' ? 'Done' : 'Note'}
          </span>
          <span>{t.message}</span>
          {t.action && (
            <button
              className="btn"
              onClick={() => {
                t.action!.run()
                dismiss(t.id)
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="btn-icon" aria-label="Dismiss message" onClick={() => dismiss(t.id)}>
            <IconClose />
          </button>
        </div>
      ))}
    </div>
  )
}

/** Background jobs (OCR, conversion, compression, ...) with live progress and Cancel. */
export function JobsTray(): JSX.Element | null {
  const order = useJobs((s) => s.order)
  const jobs = useJobs((s) => s.jobs)
  if (order.length === 0) return null
  return (
    <section aria-label="Background tasks" className="fixed bottom-4 right-4 z-[55] flex w-80 flex-col gap-2">
      {order.map((id) => {
        const j = jobs[id]
        if (!j) return null
        const running = j.state === 'running'
        return (
          <div key={id} data-job={j.kind} className="rounded-lg border border-line bg-raised p-3 shadow-lg">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{j.title}</span>
              {running && (
                <button className="btn h-7 px-2 text-xs" onClick={() => cancelJob(id)}>
                  Cancel
                </button>
              )}
            </div>
            {running ? (
              <>
                <progress className="mt-2 h-1.5 w-full" value={j.progress} max={1} aria-label={`${j.title} progress`} />
                <p className="mt-1 truncate text-xs text-ink-muted" role="status">
                  {j.message ?? `${Math.round(j.progress * 100)}%`}
                </p>
              </>
            ) : (
              <p className={`mt-1 text-xs ${j.state === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-ink-muted'}`} role={j.state === 'failed' ? 'alert' : 'status'}>
                {j.state === 'done' ? 'Finished' : j.state === 'cancelled' ? 'Cancelled' : `Failed: ${j.error ?? 'unknown error'}`}
              </p>
            )}
          </div>
        )
      })}
    </section>
  )
}

/** Renders the pending `askConfirm(...)` request, if any. */
export function ConfirmHost(): JSX.Element | null {
  const req = useConfirm((s) => s.request)
  if (!req) return null
  const cancel = req.cancelValue ?? req.buttons[req.buttons.length - 1].value
  const initial = req.buttons.find((b) => b.variant === 'primary') ?? req.buttons[0]
  return (
    <Modal title={req.title} onClose={() => req.resolve(cancel)}>
      <p className="mb-4 whitespace-pre-line text-ink-muted">{req.message}</p>
      <div className="flex flex-wrap justify-end gap-2">
        {req.buttons.map((b) => (
          <button
            key={b.value}
            autoFocus={b === initial}
            className={b.variant === 'primary' ? 'btn-primary' : b.variant === 'danger' ? 'btn border-red-500/60 text-red-700 dark:text-red-300' : 'btn'}
            onClick={() => req.resolve(b.value)}
          >
            {b.label}
          </button>
        ))}
      </div>
    </Modal>
  )
}
