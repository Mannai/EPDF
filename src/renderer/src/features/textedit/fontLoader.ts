import boldUrl from './fonts/NotoSans-Bold.ttf?url'
import boldItalicUrl from './fonts/NotoSans-BoldItalic.ttf?url'
import italicUrl from './fonts/NotoSans-Italic.ttf?url'
import regularUrl from './fonts/NotoSans-Regular.ttf?url'
import type { FontLoader } from './pdfcontent/textEdit'

/**
 * The bundled Unicode font used when the document's own font cannot show new text: Noto Sans (SIL Open Font
 * License 1.1, see ./fonts/OFL.txt). It ships inside the app, so nothing is downloaded at run time.
 */
const cache = new Map<string, Promise<Uint8Array>>()

function load(url: string): Promise<Uint8Array> {
  let p = cache.get(url)
  if (!p) {
    p = fetch(url).then(async (res) => {
      if (!res.ok) throw new Error('The bundled font could not be loaded.')
      return new Uint8Array(await res.arrayBuffer())
    })
    p.catch(() => cache.delete(url))
    cache.set(url, p)
  }
  return p
}

export const fontLoader: FontLoader = {
  unicodeFont: (style) => load(style.bold ? (style.italic ? boldItalicUrl : boldUrl) : style.italic ? italicUrl : regularUrl)
}
