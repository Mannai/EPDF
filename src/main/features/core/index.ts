import { commandItem, contributeMenu } from '../../menu/contributions'
import type { MainContext } from '../api'

/** Main-process half of the built-in "core" feature: its menu items. Behaviour lives in the renderer. */
export function register(_ctx: MainContext): void {
  contributeMenu({
    menu: 'Document',
    position: 'end',
    items: () => [
      { type: 'separator' },
      commandItem('Rotate Page Clockwise', 'page.rotateCW', 'CmdOrCtrl+]'),
      commandItem('Rotate Page Counterclockwise', 'page.rotateCCW', 'CmdOrCtrl+[')
    ]
  })
}
