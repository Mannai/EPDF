import { useEffect, useRef } from 'react'

/** Small shared pieces of the scan dialog. */

/** Paints an ImageBitmap on a canvas (the bitmap may be replaced/closed at any time). */
export function BitmapCanvas({ bitmap, label, className, testId }: { bitmap?: ImageBitmap; label: string; className?: string; testId?: string }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c || !bitmap) return
    try {
      c.width = bitmap.width
      c.height = bitmap.height
      c.getContext('2d')?.drawImage(bitmap, 0, 0)
    } catch {
      /* the bitmap was closed by a newer render */
    }
  }, [bitmap])
  // an empty label marks the canvas as decorative (thumbnails next to a text label)
  return <canvas ref={ref} role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : true} className={className} data-testid={testId} />
}

export function Field({ label, children, hint }: { label: string; children: (id: string) => JSX.Element; hint?: string }): JSX.Element {
  const id = `f-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
  return (
    <div className="mb-3">
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children(id)}
      {hint && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
    </div>
  )
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

export function Spinner({ label }: { label: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-ink-muted">
      <span aria-hidden="true" className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-line border-t-accent" />
      {label}
    </span>
  )
}
