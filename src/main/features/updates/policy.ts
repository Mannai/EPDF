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

/** Milliseconds until the next background check is due (0 = now). `lastCheck` is epoch ms, or null if never. */
export function msUntilNextAutoCheck(now: number, lastCheck: number | null, intervalMs = AUTO_CHECK_INTERVAL_MS): number {
  if (lastCheck === null || !Number.isFinite(lastCheck) || lastCheck > now) return 0 // never checked, or the clock went back
  return Math.max(0, lastCheck + intervalMs - now)
}
