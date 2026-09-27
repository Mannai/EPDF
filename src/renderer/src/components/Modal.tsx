import { useEffect, useRef } from 'react'

/**
 * An accessible modal dialog: labelled, traps Tab, closes on Escape, and returns focus to whatever had it.
 * Features build their dialogs on this so they behave (and are announced) the same way.
 */
export function Modal({
  title,
  description,
  children,
  onClose,
  wide,
  size
}: {
  title: string
  /** One line under the title saying what the dialog does (Windows 11 dialog style). */
  description?: string
  children: React.ReactNode
  onClose(): void
  wide?: boolean
  /** s = 400 px, m = 640 px (same as `wide`), l = 900 px. */
  size?: 's' | 'm' | 'l'
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<Element | null>(document.activeElement)

  useEffect(() => {
    // Move focus into the dialog (unless a control already grabbed it with `autoFocus`), so keyboard
    // users, screen readers and Escape all work immediately; restore focus to the opener on close.
    const root = ref.current
    if (root && !root.contains(document.activeElement)) {
      const first = root.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      ;(first ?? root).focus()
    }
    const prev = returnFocus.current as HTMLElement | null
    return () => prev?.focus?.()
  }, [])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Tab' && ref.current) {
      const f = ref.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
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

  const width = size === 'l' ? 'w-[900px]' : size === 'm' || wide ? 'w-[640px]' : 'w-[400px]'
  // A large dialog has a fixed height and scrolls inside its own panes, so its footer never scrolls away.
  const large = size === 'l'
  return (
    <div className="dialog-scrim" onKeyDown={onKeyDown}>
      {/* Windows: the title bar strip stays draggable but inert while the dialog is open (index.css, "Overlays"). */}
      <div aria-hidden="true" className="overlay-titlebar-guard" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`modal epdf-dialog ${width} ${large ? 'h-[min(700px,85vh,calc(100vh-var(--titlebar-h)-24px))]' : 'overflow-y-auto'} focus-visible:outline-none`}
      >
        <div className="flex shrink-0 flex-col gap-0.5 px-6 pb-3 pt-5">
          <h2 className="dialog-title m-0">{title}</h2>
          {description && <p className="dialog-desc m-0">{description}</p>}
        </div>
        {/* The last row of buttons becomes the grey footer (see .epdf-dialog-body in index.css). */}
        <div className={large ? 'flex min-h-0 flex-1 flex-col px-6' : 'epdf-dialog-body px-6 pb-5'}>{children}</div>
      </div>
    </div>
  )
}
