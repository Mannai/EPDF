import { app, dialog, nativeTheme } from 'electron'
import { join } from 'node:path'
import { Controller, pdfPathsFromArgv } from './controller'
import { openRepos } from './db'
import { FeatureKv } from './db/repos'
import { bindFeatureWindows } from './features/api'
import { loadFeatures } from './features'
import { registerIpcHandlers } from './ipc/handlers'
import { createJobs } from './jobs'
import { installMenus } from './menu/appMenu'
import { installSecurity } from './security'
import { openBundledText } from './services/bundledText'
import { askForEula, EULA_PROMPT, eulaNeedsAcceptance } from './services/eula'
import { applyHardwareAccelerationChoice } from './services/gpu'
import { registerAppProtocol, registerSchemePrivileges } from './services/protocol'

registerSchemePrivileges()

// Test hook: a synthetic camera so webcam features can be tested without hardware or a permission prompt.
if (process.env['EPDF_FAKE_MEDIA']) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
}

// Tests (and multi-profile use) can point the app at an isolated profile directory.
if (process.env['EPDF_USER_DATA']) app.setPath('userData', process.env['EPDF_USER_DATA'])

// View > Use Hardware Acceleration (read from the profile, so after userData is known and before the app is ready).
applyHardwareAccelerationChoice()

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  void start()
}

async function start(): Promise<void> {
  // macOS delivers "open with" / dock-drop / double-click through this event, possibly before ready.
  const pendingOpen: string[] = []
  let controller: Controller | null = null
  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (controller) void controller.openPaths([path])
    else pendingOpen.push(path)
  })

  await app.whenReady()
  app.setAppUserModelId('com.epdf.app')

  const repos = openRepos(join(app.getPath('userData'), 'epdf.db'))
  // The license agreement, where no installer asked for it (Linux, macOS): nothing opens until it is accepted.
  if (eulaNeedsAcceptance(process.platform, repos.settings.getFlag('eulaAccepted'))) {
    const ok = await askForEula({
      ask: async () => {
        const { response } = await dialog.showMessageBox({ type: 'info', title: 'Epdf', ...EULA_PROMPT, buttons: [...EULA_PROMPT.buttons], defaultId: 0, cancelId: 2, noLink: true })
        return (['agree', 'read', 'quit'] as const)[response] ?? 'quit'
      },
      openAgreement: () => openBundledText('EULA'),
      remember: (v) => repos.settings.setFlag('eulaAccepted', v)
    })
    if (!ok) {
      repos.db.close()
      app.exit(0)
      return
    }
  }
  const c = new Controller(repos, app.getPath('userData'))
  controller = c
  c.applyTheme()

  installSecurity()
  registerAppProtocol({
    rendererRoot: join(__dirname, '../renderer'),
    registry: c.registry,
    devOrigin: !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
  })

  // Extension points: feature channels, background jobs, then every src/main/features/<name>/index.ts.
  bindFeatureWindows(c.windows)
  const jobs = createJobs(c.windows)
  registerIpcHandlers(c)
  loadFeatures({
    controller: c,
    repos,
    files: c.files,
    jobs,
    windows: c.windows,
    kv: (feature) => new FeatureKv(repos.db, feature),
    pathOfDoc: (docId) => c.registry.pathOf(docId)
  })
  installMenus(c)
  c.onMenuSettingChanged = () => installMenus(c)
  c.onRecentsChanged = () => {
    installMenus(c)
    c.windows.broadcast('recent:changed', undefined)
  }

  nativeTheme.on('updated', () => c.windows.broadcast('theme:changed', { darkMode: nativeTheme.shouldUseDarkColors }))

  app.on('second-instance', (_e, argv) => {
    const paths = pdfPathsFromArgv(argv)
    if (paths.length) void c.openPaths(paths)
    else if (argv.includes('--new-window') || c.windows.all().length === 0) c.newWindow()
    else c.windows.focused()?.win.focus()
  })

  app.on('activate', () => {
    if (c.windows.all().length === 0) c.newWindow()
  })

  app.on('before-quit', () => {
    c.quitting = true
  })
  app.on('will-quit', () => {
    // Only now is the quit real (a window may have vetoed it), so this is when the exit counts as clean.
    repos.settings.setFlag('cleanExit', '1')
    jobs.cancelAll()
    c.registry.disposeAll()
    repos.db.close()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Startup: explicit files win; otherwise restore the last session (always after a crash).
  const argPaths = [...pdfPathsFromArgv(process.argv), ...pendingOpen]
  const crashed = repos.settings.getFlag('cleanExit') === '0'
  repos.settings.setFlag('cleanExit', '0')

  let restored = false
  if (crashed || (argPaths.length === 0 && c.settings.restoreOnLaunch)) restored = await c.restoreSession()
  if (argPaths.length) await c.openPaths(argPaths)
  else if (!restored) c.newWindow()
}
