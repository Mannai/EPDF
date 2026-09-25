import { commandItem, contributeMenu } from '../../menu/contributions'
import type { MainContext } from '../api'

/**
 * Main-process half of "Reduce File Size": only the menu item. Compression itself runs in a renderer Web Worker on bytes the
 * renderer already holds (the document's current edit state), so there is nothing to read or write from main.
 */
export function register(_ctx: MainContext): void {
  contributeMenu({
    menu: 'File',
    position: 'end',
    items: () => [{ type: 'separator' }, commandItem('Reduce File Size…', 'compress.open')]
  })
}
