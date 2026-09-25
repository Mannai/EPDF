import { useEffect, useRef } from 'react'

/**
 * An accessible modal dialog: labelled, traps Tab, closes on Escape, and returns focus to whatever had it.
 * Features build their dialogs on this so they behave (and are announced) the same way.
 */
export function Modal({
  title,
  children,
  onClose,
  wide
}: {
  title: string
  children: React.ReactNode
  onClose(): void
  wide?: boolean
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

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24" onKeyDown={onKeyDown}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`${wide ? 'w-[40rem]' : 'w-96'} max-h-[80vh] max-w-[92vw] overflow-y-auto rounded-lg border border-line bg-raised p-5 shadow-2xl`}
      >
        <h2 className="mb-3 text-base font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  )
}
