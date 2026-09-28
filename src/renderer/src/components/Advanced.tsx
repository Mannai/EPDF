import { useId, useState, type ReactNode } from 'react'

/**
 * "Advanced options" in a dialog or panel: the settings most people never change stay folded away, so the common
 * ones are easy to find; nothing is removed. Opening it is remembered per dialog (`id`), so someone who uses these
 * settings finds them open next time. `forceOpen` shows it anyway (for example when a field inside has a problem);
 * `summary` says, while folded, what inside differs from the defaults.
 */
const KEY = 'epdf.advanced.'

function remembered(id: string): boolean {
  try {
    return localStorage.getItem(KEY + id) === '1'
  } catch {
    return false
  }
}
function remember(id: string, open: boolean): void {
  try {
    if (open) localStorage.setItem(KEY + id, '1')
    else localStorage.removeItem(KEY + id)
  } catch {
    /* a convenience only */
  }
}

export function Advanced({
  id,
  children,
  forceOpen = false,
  summary,
  label = 'Advanced options',
  className = 'mt-3'
}: {
  id: string
  children: ReactNode
  forceOpen?: boolean
  summary?: string
  label?: string
  className?: string
}): JSX.Element {
  const [open, setOpen] = useState(() => remembered(id))
  const shown = open || forceOpen
  const panel = useId()
  return (
    <div className={`${className} border-t border-line pt-2`} data-advanced={id}>
      <button
        type="button"
        className="focus-inset inline-flex items-center gap-1 rounded-sm text-xs font-semibold text-ink-muted hover:text-ink"
        aria-expanded={shown}
        aria-controls={panel}
        data-advanced-toggle=""
        onClick={() => {
          setOpen(!shown)
          remember(id, !shown)
        }}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className={`h-3 w-3 transition-transform ${shown ? 'rotate-90' : ''}`}>
          <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {label}
        {!shown && summary ? <span className="font-normal">· {summary}</span> : null}
      </button>
      {shown && (
        <div id={panel} className="mt-1">
          {children}
        </div>
      )}
    </div>
  )
}
