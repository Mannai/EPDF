/** Pure decisions for the auto-updater (no Electron imports, so they are unit-tested). */

export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Wait this long after launch before the first background check, so it never competes with startup. */
export const AUTO_CHECK_STARTUP_DELAY_MS = 20_000

/** Fields of the packaged package.json that the updater cares about. */
export interface UpdateMeta {
  /** Set only by test builds (`--config.extraMetadata.epdfTestBuild=true`). Never set in a release build. */
  epdfTestBuild?: boolean
}

/**
 * The update feed can be redirected with EPDF_UPDATE_URL, but only in a test build. In a release build the
 * environment is ignored, so nothing on the user's machine can point the app at another update server.
 */
export function feedOverride(env: Record<string, string | undefined>, meta: UpdateMeta): string | null {
  if (meta.epdfTestBuild !== true) return null
  const url = env['EPDF_UPDATE_URL']
  return url && /^https?:\/\//i.test(url) ? url : null
}

/** In a test build the confirmation prompts can be answered automatically (there is no way to click a native dialog). */
export function autoAnswerPrompts(env: Record<string, string | undefined>, meta: UpdateMeta): boolean {
  return meta.epdfTestBuild === true && env['EPDF_UPDATE_TEST_ACCEPT'] === '1'
}

/** Public release channel: the update feed (electron-builder.yml `publish`) and the page a user downloads from. */
export const RELEASES_REPO = { owner: 'Mannai', repo: 'EPDF' } as const

/** The release page of one version (the tags are `v<version>`). */
export function releasePageUrl(version: string): string {
  return `https://github.com/${RELEASES_REPO.owner}/${RELEASES_REPO.repo}/releases/tag/v${encodeURIComponent(version)}`
}

/**
 * A pre-release (`1.0.8-beta.1`) follows the pre-release channel, so betas find newer betas. A release version only
 * looks at full releases, so nobody on a release is moved onto a beta.
 */
export function followsPrereleases(currentVersion: string): boolean {
  return /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+/.test(currentVersion)
}

/**
 * Whether the app can download and install its own update. Windows (NSIS) and macOS can, and so can an AppImage
 * (electron-updater replaces the file named by $APPIMAGE). A .deb is owned by the system's package manager, so there
 * the app only tells the user about the new version.
 */
export function canInstallUpdates(platform: NodeJS.Platform, env: Record<string, string | undefined>): boolean {
  if (platform !== 'linux') return true
  return !!env['APPIMAGE']
}

/** Milliseconds until the next background check is due (0 = now). `lastCheck` is epoch ms, or null if never. */
export function msUntilNextAutoCheck(now: number, lastCheck: number | null, intervalMs = AUTO_CHECK_INTERVAL_MS): number {
  if (lastCheck === null || !Number.isFinite(lastCheck) || lastCheck > now) return 0 // never checked, or the clock went back
  return Math.max(0, lastCheck + intervalMs - now)
}
