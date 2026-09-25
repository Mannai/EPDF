import { commandItem, contributeMenu } from '../../menu/contributions'
import type { MainContext } from '../api'

/**
 * Main-process half of "security": only the menu items. Protecting and unlocking documents happens entirely in the
 * renderer (pure TypeScript crypto through the edit pipeline hooks), so no channel and no file access is needed here.
 */
export function register(_ctx: MainContext): void {
  contributeMenu({
    menu: 'Tools',
    items: () => [
      { type: 'separator' },
      commandItem('Protect with Password…', 'security.protect'),
      commandItem('Remove Password Protection…', 'security.remove'),
      { label: 'Document Properties', submenu: [commandItem('Security…', 'security.info')] }
    ]
  })
}
