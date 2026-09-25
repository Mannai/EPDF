import * as pdfjs from 'pdfjs-dist'
import { create } from 'zustand'
import type { LibraryItem } from '@shared/features/library'
import '../../pdf/docCache' // configures pdf.js's worker
import { libraryApi } from './api'

/**
 * First-page thumbnails. The PNGs are cached by main (userData/library-thumbs); a missing one is rendered here with
 * the normal PDF.js (already loaded for the viewer, and its rendering runs in its own worker) one file at a time,
 * only for rows that are on screen, and sent back to main to be cached. No native canvas module is needed.
 */

interface ThumbState {
  urls: Record<string, string>
  /** Refs that cannot be rendered: not retried until the library is reopened. */
  failed: Record<string, true>
}

export const useThumbs = create<ThumbState>(() => ({ urls: {}, failed: {} }))

const WIDTH = 200
const HEIGHT = 260

const wanted = new Set<string>() // rows currently on screen
const known = new Map<string, LibraryItem>()
const requested = new Set<string>()
const queue: string[] = []
let toFetch = new Set<string>()
let fetchTimer: ReturnType<typeof setTimeout> | null = null
let running = false
let generation = 0

/** Cloud-only, password-protected and oversized files never get a picture (that would download/unlock them). */
export const canThumb = (i: LibraryItem): boolean => i.inLibrary && !i.cloud && i.state !== 'cloud' && i.state !== 'unindexable' && i.state !== 'too_large'

/** Called by a row that is on screen. */
export function wantThumb(item: LibraryItem): void {
  if (!item.inLibrary) return
  wanted.add(item.ref)
  const prev = known.get(item.ref)
  if (prev && (prev.size !== item.size || prev.mtime !== item.mtime)) {
    // The file changed since its picture was made: drop it and make a new one.
    requested.delete(item.ref)
    useThumbs.setState((s) => {
      const { [item.ref]: _gone, ...rest } = s.urls
      return { urls: rest }
    })
  }
  known.set(item.ref, item)
  if (requested.has(item.ref) || useThumbs.getState().urls[item.ref]) return
  requested.add(item.ref)
  toFetch.add(item.ref)
  fetchTimer ??= setTimeout(() => void fetchCached(), 40)
}

export function unwantThumb(ref: string): void {
  wanted.delete(ref)
}

/** Forget everything (library closed or cleared). */
export function resetThumbs(): void {
  generation++
  wanted.clear()
  known.clear()
  requested.clear()
  queue.length = 0
  toFetch = new Set()
  if (fetchTimer) clearTimeout(fetchTimer)
  fetchTimer = null
  useThumbs.setState({ urls: {}, failed: {} })
}

async function fetchCached(): Promise<void> {
  fetchTimer = null
  const refs = [...toFetch]
  toFetch = new Set()
  const gen = generation
  if (refs.length === 0) return
  let cached: Record<string, string> = {}
  try {
    cached = await libraryApi.thumbs(refs)
  } catch {
    /* not cached: render them below */
  }
  if (gen !== generation) return
  if (Object.keys(cached).length) useThumbs.setState((s) => ({ urls: { ...s.urls, ...cached } }))
  for (const ref of refs) {
    const item = known.get(ref)
    if (!cached[ref] && item && canThumb(item)) queue.push(ref)
  }
  void pump()
}

async function pump(): Promise<void> {
  if (running) return
  running = true
  const gen = generation
  try {
    while (queue.length > 0 && gen === generation) {
      // Newest first: what the user scrolled to last is what they are looking at.
      const ref = queue.pop()!
      if (!wanted.has(ref) || useThumbs.getState().urls[ref]) {
        requested.delete(ref) // scrolled away: ask again if it comes back into view
        continue
      }
      let url: string | null = null
      try {
        url = await render(ref, gen)
      } catch {
        url = null
      }
      if (gen !== generation) break
      if (url) useThumbs.setState((s) => ({ urls: { ...s.urls, [ref]: url! } }))
      else useThumbs.setState((s) => ({ failed: { ...s.failed, [ref]: true } }))
      await new Promise((r) => setTimeout(r, 30)) // leave the UI thread some air between renders
    }
  } finally {
    running = false
  }
}

const dataUrlToBytes = (dataUrl: string): Uint8Array => {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function render(ref: string, gen: number): Promise<string | null> {
  const src = await libraryApi.thumbSource(ref)
  if (!src) return null
  try {
    const info = await window.epdf.getAppInfo()
    const task = pdfjs.getDocument({
      url: `${info.docBaseUrl}${src.docId}`,
      rangeChunkSize: 1 << 17,
      disableAutoFetch: true,
      enableXfa: false,
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      wasmUrl: '/pdfjs/wasm/',
      iccUrl: '/pdfjs/iccs/'
    })
    try {
      const doc = await task.promise
      const page = await doc.getPage(1)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: Math.min(WIDTH / base.width, HEIGHT / base.height) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.floor(viewport.width))
      canvas.height = Math.max(1, Math.floor(viewport.height))
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, canvas, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise
      const url = canvas.toDataURL('image/png')
      if (gen === generation) await libraryApi.saveThumb(ref, dataUrlToBytes(url), doc.numPages)
      return url
    } finally {
      await task.destroy().catch(() => undefined)
    }
  } finally {
    void window.epdf.closeDoc(src.docId)
  }
}
