import { app, dialog, shell, type BrowserWindow, type MessageBoxOptions } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contributeMenu } from '../../menu/contributions'
import type { MainContext } from '../api'
import { createUpdateFlow, type UpdateUi, type UpdaterLike } from './flow'
import {
  AUTO_CHECK_INTERVAL_MS,
  AUTO_CHECK_STARTUP_DELAY_MS,
  autoAnswerPrompts,
  canInstallUpdates,
  feedOverride,
  followsPrereleases,
  msUntilNextAutoCheck,
  releasePageUrl,
  type UpdateMeta
} from './policy'

/**
 * Updates (installed builds): Help ▸ Check for Updates… and an optional background check once a day.
 *
 * The feed is the `publish` entry in electron-builder.yml, the public GitHub releases of Mannai/epdf-releases (baked
 * into the installed app as resources/app-update.yml; public, so no token is involved). Nothing is downloaded without
 * the user saying yes, and an update installs only when the app really quits. On a Linux .deb the app only says that a
 * new version is out and offers its download page. electron-updater is loaded on first use so it costs nothing at startup.
 */
export function register(ctx: MainContext): void {
  const kv = ctx.kv('updates')
  const meta = readMeta()
  const auto = autoAnswerPrompts(process.env, meta)
  const canInstall = canInstallUpdates(process.platform, process.env)

  const focusedWindow = (): BrowserWindow | undefined => ctx.windows.focused()?.win
  const say = async (options: MessageBoxOptions): Promise<number> => {
    const win = focusedWindow()
    const full: MessageBoxOptions = { title: 'Epdf', noLink: true, ...options }
    return (win ? await dialog.showMessageBox(win, full) : await dialog.showMessageBox(full)).response
  }

  const ui: UpdateUi = {
    confirmDownload: async (version, current) =>
      auto ||
      (await say({
        type: 'info',
        message: `Epdf ${version} is available`,
        detail: `You have version ${current}. Download the update now? Your work is not affected; it is installed the next time Epdf closes.`,
        buttons: ['Download', 'Not Now'],
        defaultId: 0,
        cancelId: 1
      })) === 0,
    confirmRestart: async (version) =>
      auto ||
      (await say({
        type: 'info',
        message: `Epdf ${version} is ready to install`,
        detail: 'Restart Epdf now to finish updating? You will be asked about unsaved changes first. Otherwise it installs the next time you quit.',
        buttons: ['Restart', 'Later'],
        defaultId: 0,
        cancelId: 1
      })) === 0,
    notifyUpToDate: async (current) => void (await say({ type: 'info', message: 'Epdf is up to date', detail: `You have the latest version (${current}).` })),
    notifyError: async (message) => void (await say({ type: 'warning', message: 'Could not check for updates', detail: message })),
    notifyUnavailable: async () =>
      void (await say({ type: 'info', message: 'Updates are only available in the installed app', detail: 'This copy of Epdf is not an installed release.' })),
    offerDownloadPage: async (version, current) => {
      const open =
        (await say({
          type: 'info',
          message: `Epdf ${version} is available`,
          detail: `You have version ${current}. Open the download page to get the new package? Install it the same way you installed Epdf.`,
          buttons: ['Open Download Page', 'Not Now'],
          defaultId: 0,
          cancelId: 1
        })) === 0
      if (open) await shell.openExternal(releasePageUrl(version))
      return open
    },
    progress: (fraction) => {
      for (const w of ctx.windows.all()) w.win.setProgressBar(fraction === null ? -1 : fraction)
    }
  }

  let updateReady = false // an update is downloaded and waiting for the app to quit
  let restartRequestedAt = 0 // when the user last chose "Restart"; the choice expires so a cancelled quit doesn't relaunch much later
  const RESTART_INTENT_MS = 5 * 60_000
  let updaterPromise: Promise<UpdaterLike> | null = null
  const loadUpdater = (): Promise<UpdaterLike> =>
    (updaterPromise ??= (async () => {
      // electron-updater is CommonJS; depending on how the bundler wraps it the export is named or under `default`.
      const mod = await import('electron-updater')
      const autoUpdater = mod.autoUpdater ?? (mod as unknown as { default: typeof mod }).default?.autoUpdater
      if (!autoUpdater) throw new Error('The updater could not be loaded.')
      autoUpdater.autoDownload = false // always ask first
      autoUpdater.autoInstallOnAppQuit = false // installing is done below, on the real quit, so it can also relaunch
      autoUpdater.allowDowngrade = false
      autoUpdater.allowPrerelease = followsPrereleases(app.getVersion()) // betas look for newer betas; releases only for releases
      const override = feedOverride(process.env, meta)
      if (override) autoUpdater.setFeedURL({ provider: 'generic', url: override })
      autoUpdater.on('download-progress', (p) => ui.progress(Math.min(1, Math.max(0, p.percent / 100))))
      autoUpdater.on('update-downloaded', () => {
        updateReady = true
      })
      // Runs only when the app really quits (a "Save changes?" Cancel never gets here), so nothing is lost. The
      // installer is silent; after "Restart" the new version is started again, after a plain quit it is not.
      app.on('quit', (_e, exitCode) => {
        if (!updateReady || exitCode !== 0) return
        autoUpdater.quitAndInstall(true, Date.now() - restartRequestedAt < RESTART_INTENT_MS)
      })
      return autoUpdater
    })())

  const flow = createUpdateFlow({
    // The updater is created lazily, so wrap it: the flow only ever needs these two calls.
    updater: {
      checkForUpdates: async () => (await loadUpdater()).checkForUpdates(),
      downloadUpdate: async () => (await loadUpdater()).downloadUpdate()
    },
    ui,
    currentVersion: app.getVersion(),
    canUpdate: app.isPackaged,
    canInstall,
    requestQuit: () => {
      restartRequestedAt = Date.now()
      app.quit()
    }
  })

  const check = async (manual: boolean): Promise<void> => {
    if (!manual) kv.set('lastCheck', Date.now())
    await flow.check(manual)
  }

  const autoEnabled = (): boolean => kv.get<boolean>('autoCheck', true) !== false

  // Background check: shortly after launch if a day has passed, then daily while the app stays open.
  if (app.isPackaged) {
    const schedule = (delay: number): void => {
      const t = setTimeout(() => {
        if (autoEnabled()) void check(false)
        schedule(AUTO_CHECK_INTERVAL_MS)
      }, delay)
      t.unref()
    }
    const last = kv.get<number | null>('lastCheck', null)
    schedule(Math.max(AUTO_CHECK_STARTUP_DELAY_MS, msUntilNextAutoCheck(Date.now(), last)))
  }

  contributeMenu({
    menu: 'Help',
    position: 'end',
    items: () => [
      { type: 'separator' },
      { label: 'Check for Updates…', click: () => void check(true) },
      {
        label: 'Check for Updates Automatically',
        type: 'checkbox',
        checked: autoEnabled(),
        click: (item) => kv.set('autoCheck', item.checked)
      }
    ]
  })
}

/** The bits of the packaged package.json the updater needs (a test build marks itself there). */
function readMeta(): UpdateMeta {
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as UpdateMeta
    return { epdfTestBuild: pkg.epdfTestBuild === true }
  } catch {
    return {}
  }
}
