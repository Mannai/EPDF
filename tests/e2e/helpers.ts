import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const FIX = resolve('test-results/fixtures')
export const fixture = (name: string): string => join(FIX, name)

export interface Launched {
  app: ElectronApplication
  page: Page
  userData: string
}

/** A throwaway copy of a fixture, so tests that save don't modify the shared fixtures. */
export function copyFixture(name: string, as = name): string {
  const dir = mkdtempSync(join(tmpdir(), 'epdf-doc-'))
  const dest = join(dir, as)
  copyFileSync(fixture(name), dest)
  return dest
}

/** Clicks a native menu item by menu and item label (labels compared without `&` mnemonics). */
export function menuClick(app: ElectronApplication, menu: string, item: string): Promise<void> {
  return app.evaluate(
    ({ Menu }, [m, i]) => {
      const strip = (s: string): string => s.replace('&', '')
      const top = Menu.getApplicationMenu()!.items.find((x) => strip(x.label) === m)
      const it = top?.submenu?.items.find((x) => strip(x.label) === i)
      if (!it) throw new Error(`Menu item not found: ${m} > ${i}`)
      it.click()
    },
    [menu, item]
  )
}

export async function launch(opts: { files?: string[]; userData?: string; env?: Record<string, string> } = {}): Promise<Launched> {
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'epdf-e2e-'))
  // Relaunching on a profile right after a simulated crash can hit a Chromium child that is still shutting
  // down and holds the profile lock ("Lock file can not be created"). That is the test environment, not the
  // app, so retry those specific launch failures a few times.
  for (let attempt = 1; ; attempt++) {
    try {
      const app = await electron.launch({
        args: ['.', ...(opts.files ?? [])],
        // An empty renderer URL selects the production code path (custom protocol + strict CSP).
        env: { ...process.env, EPDF_USER_DATA: userData, ELECTRON_RENDERER_URL: '', ...opts.env } as Record<string, string>
      })
      const page = await app.firstWindow()
      return { app, page, userData }
    } catch (err) {
      const transient = /Lock file|ECONNRESET|process_singleton/i.test(String(err instanceof Error ? err.message : err))
      if (!transient || attempt >= 4) throw err
      await new Promise((r) => setTimeout(r, 1500 * attempt))
    }
  }
}

/**
 * Quits an app that may have unsaved edits: if the "Save changes?" prompt appears, answers Don't Save.
 * (A plain `app.close()` would wait forever on that prompt.)
 */
export async function quitDiscarding(app: ElectronApplication, page: Page): Promise<void> {
  const closing = app.close().catch(() => undefined)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Don’t Save' })
    .click({ timeout: 2000 })
    .catch(() => undefined) // no prompt: nothing was unsaved
  await closing
}

/**
 * Simulates a hard crash: kills the whole process tree with no chance to run quit handlers.
 * (On Windows a plain kill leaves GPU/renderer children alive holding the profile lock.)
 */
export async function crash(app: ElectronApplication): Promise<void> {
  const pid = app.process().pid!
  if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else app.process().kill('SIGKILL')
  await new Promise((r) => setTimeout(r, 1000))
}

/**
 * Runs axe-core (WCAG 2.0/2.1 A + AA) against the UI and returns readable violation strings.
 * Injected directly because Electron windows can't open the extra pages @axe-core/playwright needs.
 * The rendered PDF pages are excluded: their contrast belongs to the document, not to our UI.
 */
export async function axeViolations(page: Page, label: string): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  await page.evaluate(readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'))
  const found = await page.evaluate(async () => {
    type Axe = { run(ctx: unknown, opts: unknown): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> }
    const axe = (window as unknown as { axe: Axe }).axe
    const r = await axe.run(
      { exclude: [['.epdf-page']] },
      { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }
    )
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
  })
  return found.map((f) => `[${label}] ${f}`)
}

/** The page input's current value, i.e. the page the viewer believes it is on. */
export const currentPage = (page: Page): Promise<string> => page.getByLabel('Page number').inputValue()

export async function gotoPage(page: Page, n: number): Promise<void> {
  const input = page.getByLabel('Page number')
  await input.fill(String(n))
  await input.press('Enter')
}

/** True if the canvas inside `selector` has any visibly dark pixel (i.e. something was actually drawn). */
export function canvasHasInk(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const c = document.querySelector<HTMLCanvasElement>(sel)
    if (!c || c.width === 0) return false
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    for (let i = 0; i < d.length; i += 4) if (d[i] < 128 && d[i + 3] > 0) return true
    return false
  }, selector)
}
