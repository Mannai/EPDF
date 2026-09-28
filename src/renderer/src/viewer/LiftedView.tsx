import { useLayoutEffect, useRef } from 'react'

/** Shows a prepared canvas (from `liftRegion`) at a CSS-px box inside the page; it ignores the mouse. */
export function CanvasAt({ canvas, box, testId, opacity }: { canvas: HTMLCanvasElement; box: [number, number, number, number]; testId?: string; opacity?: number }): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    canvas.style.cssText = 'width:100%;height:100%;display:block'
    el.replaceChildren(canvas)
    return () => {
      if (canvas.parentElement === el) el.removeChild(canvas)
    }
  }, [canvas])
  return (
    <div
      ref={host}
      aria-hidden="true"
      data-testid={testId}
      className="pointer-events-none absolute"
      style={{ left: box[0], top: box[1], width: box[2] - box[0], height: box[3] - box[1], opacity }}
    />
  )
}
