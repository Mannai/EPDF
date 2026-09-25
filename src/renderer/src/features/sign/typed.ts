import type { BundledFontName } from '@shared/features/forms'
import { loadBundledFont } from '../forms/fontClient'
import { finalizeSignature, makeCanvas, type SignatureImage } from './canvasUtil'

/** The script fonts bundled for typed signatures (all SIL OFL 1.1 or Apache 2.0; see docs/features/forms-signing.md). */
export const SCRIPT_FONTS: { id: BundledFontName; label: string; family: string }[] = [
  { id: 'GreatVibes', label: 'Great Vibes', family: 'Epdf Great Vibes' },
  { id: 'Allura', label: 'Allura', family: 'Epdf Allura' },
  { id: 'HomemadeApple', label: 'Homemade Apple', family: 'Epdf Homemade Apple' },
  { id: 'Sacramento', label: 'Sacramento', family: 'Epdf Sacramento' }
]

const loaded = new Map<string, Promise<void>>()

/** Registers a bundled script font with the document (once) so canvas and CSS can use it. */
export function ensureScriptFont(id: BundledFontName): Promise<void> {
  const def = SCRIPT_FONTS.find((f) => f.id === id)
  if (!def) return Promise.reject(new Error('Unknown font'))
  let p = loaded.get(id)
  if (!p) {
    p = loadBundledFont(id).then(async (bytes) => {
      const face = new FontFace(def.family, bytes.slice().buffer)
      await face.load()
      document.fonts.add(face)
    })
    p.catch(() => loaded.delete(id))
    loaded.set(id, p)
  }
  return p
}

/** Renders a name in a script font onto a transparent PNG. Null if the text is blank. */
export async function renderTypedSignature(text: string, fontId: BundledFontName, color: string): Promise<SignatureImage | null> {
  const value = text.trim()
  if (!value) return null
  await ensureScriptFont(fontId)
  const def = SCRIPT_FONTS.find((f) => f.id === fontId)!
  const size = 180
  const font = `${size}px "${def.family}"`
  const measure = makeCanvas(10, 10).getContext('2d')!
  measure.font = font
  const w = Math.ceil(measure.measureText(value).width) + size
  const canvas = makeCanvas(w, Math.round(size * 2))
  const ctx = canvas.getContext('2d')!
  ctx.font = font
  ctx.fillStyle = color
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(value, size / 2, size * 1.3)
  return finalizeSignature(canvas)
}
