import { app, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { openBundledText } from '../services/bundledText'
import { hardwareAccelerationEnabled, setHardwareAcceleration } from '../services/gpu'
import type { MenuAction } from '../../shared/types'
import type { Controller } from '../controller'
import { APP_MENU_ID, commandItem, contributionsFor, NEEDS_DOCUMENT, setCommandSender, type MenuName } from './contributions'

const isMac = process.platform === 'darwin'

type Item = MenuItemConstructorOptions

/** Wraps a menu's built-in items with whatever features contributed to its start and end. */
function withContributions(menu: MenuName, base: Item[]): Item[] {
  const start = contributionsFor(menu, 'start')
  const end = contributionsFor(menu, 'end')
  return [
    ...start,
    ...(start.length ? [{ type: 'separator' } as Item] : []),
    ...base,
    ...(end.length ? [{ type: 'separator' } as Item] : []),
    ...end
  ]
}

export function installMenus(c: Controller): void {
  const send = (action: MenuAction): void => {
    const w = c.windows.focused()
    if (w) c.windows.send(w, 'menu:action', action)
  }
  setCommandSender((id) => send({ type: 'command', id }))
  // Every action item works on the open document (zoom, find, close tab...).
  const item = (label: string, action: MenuAction, accelerator?: string): Item => ({
    id: NEEDS_DOCUMENT + action.type,
    label,
    accelerator,
    click: () => send(action)
  })

  const openViaDialog = async (): Promise<void> => {
    const w = c.windows.focused()
    if (w) return send({ type: 'open' })
    const paths = await c.pickPdfs(undefined)
    if (paths.length) await c.openPaths(paths)
  }

  const recents = c.repos.recent.list(10)
  const recentSubmenu: Item[] = [
    ...(recents.length
      ? recents.map<Item>((r) => ({ label: r.name, click: () => void c.openPaths([r.path]) }))
      : [{ label: 'No recent files', enabled: false }]),
    { type: 'separator' },
    {
      label: 'Clear Recent Files',
      enabled: recents.length > 0,
      click: () => {
        c.repos.recent.clear()
        app.clearRecentDocuments()
        c.onRecentsChanged?.()
      }
    }
  ]

  const template: Item[] = [
    ...(isMac
      ? [
          {
            // There is no Settings window: Epdf's settings are the checkable items of the Edit, View and Help menus.
            id: APP_MENU_ID,
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Set as Default PDF App…', click: () => c.setDefaultPdfApp() },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ] as Item[]
          }
        ]
      : []),
    {
      label: '&File',
      submenu: [
        ...withContributions('File', [
          { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => c.newWindow() },
          { label: '&Open…', accelerator: 'CmdOrCtrl+O', click: () => void openViaDialog() },
          { label: 'Open Recent', submenu: recentSubmenu },
          { type: 'separator' },
          commandItem('&Save', 'file.save', 'CmdOrCtrl+S'),
          commandItem('Save &As…', 'file.saveAs', 'CmdOrCtrl+Shift+S'),
          commandItem('Save a &Copy…', 'file.saveCopy'),
          commandItem('Version &History…', 'file.versionHistory'),
          { type: 'separator' },
          item('&Close Tab', { type: 'close-tab' }, 'CmdOrCtrl+W'),
          { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
          { type: 'separator' },
          item('Reload from Disk', { type: 'reload' }, 'CmdOrCtrl+R')
        ]),
        ...(isMac ? [] : ([{ type: 'separator' }, { role: 'quit' }] as Item[]))
      ]
    },
    {
      label: '&Edit',
      submenu: withContributions('Edit', [
        commandItem('&Undo', 'edit.undo', 'CmdOrCtrl+Z'),
        commandItem('&Redo', 'edit.redo', isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y'),
        // Second, hidden Redo binding for the other platform convention (on macOS both would be Cmd+Shift+Z).
        ...(isMac ? [] : [{ ...commandItem('Redo', 'edit.redo', 'CmdOrCtrl+Shift+Z'), visible: false }]),
        { type: 'separator' },
        // macOS text fields cut and paste only through these menu items (Cmd+X / Cmd+V are menu key equivalents
        // there); on Windows and Linux the fields handle the keys themselves.
        ...(isMac ? ([{ role: 'cut' }] as Item[]) : []),
        { id: NEEDS_DOCUMENT + 'copy', role: 'copy' },
        ...(isMac ? ([{ role: 'paste' }] as Item[]) : []),
        { id: NEEDS_DOCUMENT + 'selectAll', role: 'selectAll' },
        { type: 'separator' },
        item('&Find…', { type: 'find' }, 'CmdOrCtrl+F'),
        item('Find Next', { type: 'find-next' }, 'CmdOrCtrl+G'),
        item('Find Previous', { type: 'find-prev' }, 'CmdOrCtrl+Shift+G'),
        { type: 'separator' },
        {
          // Delete / Backspace on a comment, shape, link or field asks first; "Don't ask again" in that dialog turns
          // this off, and this is where it comes back.
          label: 'Ask Before Deleting',
          type: 'checkbox',
          checked: c.settings.confirmDelete,
          click: (menuItem) => {
            c.repos.settings.set('confirmDelete', menuItem.checked)
            for (const w of c.windows.all()) c.windows.send(w, 'menu:action', { type: 'settings-changed' })
          }
        },
        {
          // What saving does with Fill & sign text, marks and signatures that are still editable.
          label: 'When Saving Fill && Sign Items',
          submenu: (
            [
              ['ask', 'Ask Each Time'],
              ['lock', 'Lock Them Into the Page'],
              ['keep', 'Keep Them Editable']
            ] as const
          ).map(([value, label]) => ({
            label,
            type: 'radio' as const,
            checked: c.settings.fillSignOnSave === value,
            click: () => {
              c.repos.settings.set('fillSignOnSave', value)
              for (const w of c.windows.all()) c.windows.send(w, 'menu:action', { type: 'settings-changed' })
            }
          }))
        }
      ])
    },
    {
      label: '&View',
      submenu: withContributions('View', [
        item('Zoom In', { type: 'zoom-in' }, 'CmdOrCtrl+='),
        item('Zoom Out', { type: 'zoom-out' }, 'CmdOrCtrl+-'),
        item('Actual Size', { type: 'zoom-actual' }, 'CmdOrCtrl+0'),
        item('Fit Width', { type: 'fit-width' }, 'CmdOrCtrl+1'),
        item('Fit Page', { type: 'fit-page' }, 'CmdOrCtrl+2'),
        { type: 'separator' },
        item('Continuous Scroll', { type: 'view-mode', mode: 'continuous' }),
        item('Single Page', { type: 'view-mode', mode: 'single' }),
        item('Two-Page Spread', { type: 'view-mode', mode: 'two' }),
        { type: 'separator' },
        item('Toggle Sidebar', { type: 'toggle-sidebar' }, 'CmdOrCtrl+Shift+B'),
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          // If the window flashes black or stops repainting with some graphics drivers, turning this off fixes it.
          label: 'Use Hardware Acceleration',
          type: 'checkbox',
          checked: hardwareAccelerationEnabled(),
          click: (menuItem) => {
            setHardwareAcceleration(menuItem.checked)
            void dialog
              .showMessageBox({
                type: 'info',
                title: 'Epdf',
                message: menuItem.checked ? 'Hardware acceleration will be turned on' : 'Hardware acceleration will be turned off',
                detail: 'Restart Epdf for the change to take effect. You will be asked about unsaved changes first.',
                buttons: ['Restart Now', 'Later'],
                defaultId: 0,
                cancelId: 1,
                noLink: true
              })
              .then(({ response }) => {
                if (response !== 0) return
                app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--disable-gpu') })
                app.quit()
              })
          }
        },
        ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'toggleDevTools' }] as Item[]))
      ])
    },
    {
      label: '&Document',
      submenu: withContributions('Document', [
        item('Next Page', { type: 'page-next' }),
        item('Previous Page', { type: 'page-prev' }),
        item('First Page', { type: 'page-first' }, 'CmdOrCtrl+Home'),
        item('Last Page', { type: 'page-last' }, 'CmdOrCtrl+End'),
        item('Go to Page…', { type: 'goto-page' }, 'CmdOrCtrl+Alt+G'),
        { type: 'separator' },
        item('Move Tab to New Window', { type: 'detach-tab' })
      ])
    },
    {
      label: '&Tools',
      submenu: withContributions('Tools', [{ label: 'Set as Default PDF App…', click: () => c.setDefaultPdfApp() }])
    },
    {
      label: '&Window',
      submenu: withContributions('Window', [
        { role: 'minimize' },
        ...(isMac ? ([{ role: 'zoom' }, { type: 'separator' }] as Item[]) : []),
        item('Next Tab', { type: 'next-tab' }, 'Ctrl+Tab'),
        item('Previous Tab', { type: 'prev-tab' }, 'Ctrl+Shift+Tab'),
        // macOS also switches tabs with Cmd+Shift+] / Cmd+Shift+[ (Safari, Finder, Terminal).
        ...(isMac
          ? [
              { ...item('Next Tab', { type: 'next-tab' }, 'Cmd+Shift+]'), visible: false },
              { ...item('Previous Tab', { type: 'prev-tab' }, 'Cmd+Shift+['), visible: false }
            ]
          : []),
        ...(isMac ? ([{ type: 'separator' }, { role: 'front' }] as Item[]) : [])
      ])
    },
    {
      role: 'help',
      submenu: withContributions('Help', [
        ...(isMac ? [] : ([{ role: 'about' }, { type: 'separator' }] as Item[])),
        { label: `Epdf ${app.getVersion()}`, enabled: false },
        { label: 'End User License Agreement', click: () => void openBundledText('EULA') },
        { label: 'License', click: () => void openBundledText('LICENSE') },
        { label: 'Third-Party Notices', click: () => void openBundledText('THIRD-PARTY-NOTICES') },
        { type: 'separator' },
        { label: 'Open Log Folder', click: () => void shell.openPath(app.getPath('logs')) }
      ])
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  if (isMac) {
    app.dock?.setMenu(
      Menu.buildFromTemplate([
        { label: 'New Window', click: () => c.newWindow() },
        { type: 'separator' },
        ...recents.slice(0, 8).map<Item>((r) => ({ label: r.name, click: () => void c.openPaths([r.path]) }))
      ])
    )
  }
  if (process.platform === 'win32' && app.isPackaged) {
    try {
      app.setJumpList([
        { type: 'recent' },
        {
          type: 'tasks',
          items: [
            {
              type: 'task',
              title: 'New Window',
              program: process.execPath,
              args: '--new-window',
              iconPath: process.execPath,
              iconIndex: 0,
              description: 'Open a new Epdf window'
            }
          ]
        }
      ])
    } catch {
      /* jump list is cosmetic */
    }
  }
}
