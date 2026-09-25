import type { BundledFontName } from '@shared/features/forms'
import type { UnicodeFontProvider } from './fonts'

const cache = new Map<BundledFontName, Promise<Uint8Array>>()

/** Bytes of a font bundled with the app (asked from main by name; cached for the session). */
export function loadBundledFont(name: BundledFontName): Promise<Uint8Array> {
  let p = cache.get(name)
  if (!p) {
    p = window.epdf.call<Uint8Array>('forms:font', { name }).then((b) => new Uint8Array(b))
    p.catch(() => cache.delete(name))
    cache.set(name, p)
  }
  return p
}

/** Noto Sans, used when text can't be written with the standard PDF fonts. */
export const loadUnicodeFont: UnicodeFontProvider = () => loadBundledFont('NotoSans')
