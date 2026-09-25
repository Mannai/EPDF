import { memo, useEffect, useRef } from 'react'
import { RenderingCancelledException } from 'pdfjs-dist'
import type { RenderTask } from 'pdfjs-dist'
import type { LoadedDoc } from '../../pdf/docCache'

/**
 * One page thumbnail, rendered lazily with PDF.js when it mounts (the grid only mounts the rows near the
 * viewport) and cancelled when it unmounts. The previous picture stays until the new one is ready, so
 * edits do not make the grid flash.
 */
function ThumbImpl({ loaded, pageIndex, boxW, boxH }: { loaded: LoadedDoc; pageIndex: number; boxW: number; boxH: number }): JSX.Element {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let task: RenderTask | undefined
    const timer = setTimeout(async () => {
      try {
        const page = await loaded.doc.getPage(pageIndex + 1)
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        const scale = Math.min(boxW / base.width, boxH / base.height)
        const viewport = page.getViewport({ scale })
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr))
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr))
        canvas.style.cssText = `width:${Math.floor(viewport.width)}px;height:${Math.floor(viewport.height)}px;display:block;background:#fff;box-shadow:0 1px 3px rgb(0 0 0 / 0.35)`
        const ctx = canvas.getContext('2d', { alpha: false })
        if (!ctx) return
        task = page.render({
          canvasContext: ctx,
          canvas,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          background: 'rgb(255,255,255)'
        })
        await task.promise
        if (!cancelled) host.current?.replaceChildren(canvas)
        page.cleanup()
      } catch (err) {
        if (!(err instanceof RenderingCancelledException) && !cancelled) console.error('Thumbnail failed', err)
      }
    }, 40) // skip thumbnails the user scrolls straight past
    return () => {
      cancelled = true
      clearTimeout(timer)
      task?.cancel()
    }
  }, [loaded, pageIndex, boxW, boxH])

  useEffect(
    () => () => {
      const c = host.current?.firstElementChild as HTMLCanvasElement | null
      if (c) c.width = c.height = 0 // release the backing store
    },
    []
  )

  return <div ref={host} aria-hidden="true" className="flex items-center justify-center" style={{ width: boxW, height: boxH }} />
}

export const Thumb = memo(ThumbImpl)
