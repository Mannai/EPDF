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

/** One item of a right-click menu as main received it (see src/main/features/chrome/contextMenu.ts). */
export interface MenuEntry {
  id?: string
  label?: string
  type?: 'normal' | 'separator' | 'checkbox'
  enabled?: boolean
  checked?: boolean
  accelerator?: string
  submenu?: MenuEntry[]
}

/**
 * Right-clicks `target` (or runs `open`, e.g. a keyboard shortcut) and picks `choose` from the menu that appears,
 * through main's test hook instead of the native menu. Returns that menu. With `choose` null the menu is only recorded
 * and then dismissed.
 */
export async function contextMenu(
  app: ElectronApplication,
  target: import('@playwright/test').Locator | (() => Promise<void>),
  choose: string | null,
  position?: { x: number; y: number }
): Promise<MenuEntry[]> {
  await app.evaluate((_e, want) => {
    const g = globalThis as { __epdfContextMenuChoose?: string | null; __epdfContextMenus?: unknown[] }
    g.__epdfContextMenus = []
    g.__epdfContextMenuChoose = want ?? '\u0000dismiss'
  }, choose)
  if (typeof target === 'function') await target()
  else await target.click({ button: 'right', position })
  let menu: MenuEntry[] | undefined
  for (let i = 0; i < 100 && !menu; i++) {
    menu = await app.evaluate(() => (globalThis as { __epdfContextMenus?: MenuEntry[][] }).__epdfContextMenus?.[0])
    if (!menu) await new Promise((r) => setTimeout(r, 50))
  }
  await app.evaluate(() => {
    const g = globalThis as { __epdfContextMenuChoose?: string | null; __epdfContextMenus?: unknown[] }
    g.__epdfContextMenuChoose = null
    delete g.__epdfContextMenus
  })
  if (!menu) throw new Error('No context menu appeared')
  if (choose !== null && !flatMenu(menu).some((m) => m.label === choose && m.enabled !== false)) {
    throw new Error(`“${choose}” is not an enabled item of the menu: ${menuLabels(menu).join(' | ')}`)
  }
  return menu
}

const flatMenu = (m: MenuEntry[]): MenuEntry[] => m.flatMap((i) => [i, ...(i.submenu ? flatMenu(i.submenu) : [])])

/** The menu's item labels in order, with "—" for separators and "(off)" after disabled items. */
export const menuLabels = (m: MenuEntry[]): string[] =>
  m.map((i) => (i.type === 'separator' ? '—' : `${i.label}${i.enabled === false ? ' (off)' : ''}${i.checked ? ' ✓' : ''}`))

export async function launch(opts:{ files?: string[]; userData?: string; env?: Record<string, string> } = {}): Promise<Launched> {
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
      const transient = /Lock file|ECONNRESET|process_singleton|Process failed to launch/i.test(String(err instanceof Error ? err.message : err))
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
    // Measure the settled colours: controls fade colours on hover/press (~100 ms), and a scan taken right after a
    // click or hover would otherwise read a half-faded colour as a contrast failure.
    const freeze = document.createElement('style')
    freeze.textContent = '*, *::before, *::after { transition: none !important; }'
    document.head.appendChild(freeze)
    try {
      const r = await axe.run(
        { exclude: [['.epdf-page']] },
        { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }
      )
      return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
    } finally {
      freeze.remove()
    }
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

/**
 * The ribbon shows one task's tools at a time (Comment, Draw, Fill & sign, ...). Shows the task that holds the tool
 * with this id or visible label, so the tool's button can then be found and clicked. No-op if it is already showing.
 */
export async function showToolTask(page: Page, tool: string): Promise<void> {
  const tasks = page.locator('[data-task]')
  await tasks.first().waitFor({ state: 'visible', timeout: 15_000 })
  const n = await tasks.count()
  for (let i = 0; i < n; i++) {
    const t = tasks.nth(i)
    const ids = ((await t.getAttribute('data-tools')) ?? '').split(' ')
    const labels = ((await t.getAttribute('data-tool-labels')) ?? '').split('|')
    if (!ids.includes(tool) && !labels.includes(tool)) continue
    if ((await t.getAttribute('aria-pressed')) !== 'true') await t.click()
    return
  }
  throw new Error(`No ribbon task holds the tool "${tool}"`)
}

/** Clicks a ribbon tool by id (`data-tool`) or by its visible label, showing its task first. */
export async function clickTool(page: Page, tool: string): Promise<void> {
  await showToolTask(page, tool)
  const byId = page.locator(`button[data-tool="${tool}"]`)
  const target = (await byId.count()) ? byId : page.getByRole('toolbar', { name: 'Editing tools' }).getByRole('button', { name: tool, exact: true })
  await target.click()
}

/**
 * The system clipboard is shared by every test worker. Anything that copies and then reads it back runs inside this
 * cross-process lock (a directory in the temp folder), so parallel tests can't overwrite each other's clipboard.
 */
export async function withSystemClipboard<T>(fn: () => Promise<T>): Promise<T> {
  const { mkdirSync, rmSync, statSync } = await import('node:fs')
  const lock = join(tmpdir(), 'epdf-e2e-clipboard.lock')
  const started = Date.now()
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch {
      // A lock older than a minute belongs to a crashed worker.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 60_000) rmSync(lock, { recursive: true, force: true })
      } catch {
        /* gone already */
      }
      if (Date.now() - started > 120_000) throw new Error('timed out waiting for the clipboard lock')
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/**
 * Windows only: asks Windows itself what a real click at the centre of each element would do (WM_NCHITTEST), without
 * moving the cursor. Playwright's clicks go straight into the page and skip this, so a control hidden under the
 * title bar's drag area or caption buttons still "works" in a normal test while real users can't click it.
 * Returns 'client' (the click reaches the app), 'drag' (it would drag the window), or 'caption' (a window button).
 */
export async function windowsHitTest(app: ElectronApplication, page: Page, selector: string): Promise<{ name: string; hit: 'client' | 'drag' | 'caption' | string }[]> {
  const info = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!
    return { hwnd: w.getNativeWindowHandle().readBigInt64LE().toString(), content: w.getContentBounds() }
  })
  const targets = await page.evaluate((sel) => {
    return [...document.querySelectorAll<HTMLElement>(sel)]
      .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
      .filter((el) => {
        // only controls whose centre is on screen (and not scrolled out of their own container)
        const r = el.getBoundingClientRect()
        const cx = r.x + r.width / 2
        const cy = r.y + r.height / 2
        if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) return false
        if (el.hasAttribute('data-hit-probe')) return true // a marker placed on purpose over an empty area
        const top = document.elementFromPoint(cx, cy)
        return !!top && (el === top || el.contains(top) || top.contains(el))
      })
      .map((el) => {
        const r = el.getBoundingClientRect()
        const name = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent?.trim().slice(0, 30) || el.tagName
        return { name, x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
  }, selector)
  if (targets.length === 0) return []
  const dpr = await page.evaluate(() => devicePixelRatio)
  const pts = targets.map((t) => `${Math.round((info.content.x + t.x) * dpr)},${Math.round((info.content.y + t.y) * dpr)}`).join(';')
  const script = [
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public static class EpdfHit { [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }',
    '"@',
    `$h = [IntPtr]::new([Int64]'${info.hwnd}')`,
    `foreach ($p in '${pts}'.Split(';')) { $xy = $p.Split(','); $l = ([int]$xy[1] -shl 16) -bor ([int]$xy[0] -band 0xFFFF); [EpdfHit]::SendMessage($h, 0x84, [IntPtr]::Zero, [IntPtr]$l).ToInt64() }`
  ].join('\n')
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
  const codes = out.trim().split(/\s+/)
  const label = (c: string): string => (c === '1' ? 'client' : c === '2' ? 'drag' : ['8', '9', '20'].includes(c) ? 'caption' : `code ${c}`)
  return targets.map((t, i) => ({ name: t.name, hit: label(codes[i] ?? '') }))
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
