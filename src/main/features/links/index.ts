import { commandItem, contributeMenu } from '../../menu/contributions'
import type { MainContext } from '../api'

/**
 * Menu items for the links feature. Everything else (reading and writing link annotations) happens in the
 * renderer through the edit pipeline; there is no main-process logic and no file access.
 */
export function register(_ctx: MainContext): void {
  contributeMenu({ menu: 'View', position: 'end', items: () => [commandItem('Highlight Links', 'links.toggleHighlight')] })
  contributeMenu({
    menu: 'Tools',
    position: 'end',
    items: () => [
      { type: 'separator' },
      commandItem('Add Link Tool', 'links.tool.add'),
      commandItem('Edit Links Tool', 'links.tool.edit'),
      commandItem('Link from Selected Text', 'links.fromSelection'),
      commandItem('Add Link on Current Page', 'links.addHere'),
      commandItem('Find Web and E-mail Addresses…', 'links.detect'),
      commandItem('Remove Links from Current Page', 'links.removePage'),
      commandItem('Remove All Links…', 'links.removeAll')
    ]
  })
}
