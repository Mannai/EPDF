// End-to-end check of the auto-update path on Windows, with real installers and a local update server.
//
//   node scripts/update-e2e.mjs --old "dist/upd-0.1.0/Epdf Setup 0.1.0.exe" --feed dist/upd-0.1.1 [--tamper]
//
// Both installers must be TEST builds (electron-builder ... --config.extraMetadata.epdfTestBuild=true), which is
// the only kind that honours EPDF_UPDATE_URL / EPDF_UPDATE_TEST_ACCEPT. The script:
//   1. serves the newer release folder (latest.yml + installer + blockmap) on 127.0.0.1,
//   2. silently installs the old version into a temp folder,
//   3. launches it and runs Help > Check for Updates (prompts auto-accepted),
//   4. waits for the app to quit, the installer to run, and the new version to be on disk (and running again),
//   5. uninstalls and checks nothing is left.
// With --tamper the served installer is corrupted: the update must be REFUSED and the old version must survive.
import { _electron as electron } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const oldInstaller = resolve(opt('--old') ?? '')
const feedDir = resolve(opt('--feed') ?? '')
const tamper = args.includes('--tamper')
if (!existsSync(oldInstaller) || !existsSync(feedDir)) throw new Error('usage: --old <installer.exe> --feed <folder with latest.yml>')

const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim()
const versionOf = (exe) => ps(`(Get-Item '${exe}').VersionInfo.ProductVersion`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fail = (m) => { console.error('FAIL ' + m); process.exitCode = 1 }
const pass = (m) => console.log('PASS ' + m)

const wantVersion = /^version: (.+)$/m.exec(readFileSync(join(feedDir, 'latest.yml'), 'utf8'))[1].trim()

// The updater keeps a downloaded installer in %LOCALAPPDATA%\epdf-updater (shared by every Epdf install and profile);
// a leftover from an earlier run would make it skip the download this test wants to observe.
if (process.env.LOCALAPPDATA) rmSync(join(process.env.LOCALAPPDATA, 'epdf-updater'), { recursive: true, force: true })

// 1. update server
const requests = []
const server = createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1))
  const file = join(feedDir, name)
  requests.push(name)
  if (!existsSync(file) || !statSync(file).isFile() || name.includes('..')) { res.writeHead(404); res.end(); return }
  const size = statSync(file).size
  if (tamper && name.endsWith('.exe')) {
    // Same length, flipped bytes: a download that is not what latest.yml promised.
    res.writeHead(200, { 'Content-Length': size })
    const src = createReadStream(file)
    let first = true
    src.on('data', (c) => { if (first) { first = false; c = Buffer.from(c); for (let i = 1000; i < 1100 && i < c.length; i++) c[i] ^= 0xff } res.write(c) })
    src.on('end', () => res.end())
    return
  }
  res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/octet-stream' })
  createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const feed = `http://127.0.0.1:${server.address().port}`
console.log(`# feed ${feed} serves ${wantVersion}${tamper ? ' (TAMPERED installer)' : ''}`)

// 2. silent install of the old version
// realpath: os.tmpdir() can be an 8.3 short path (ADMINI~1), but running processes report the long one.
const dir = join(mkdtempSync(join(realpathSync.native(tmpdir()), 'epdf-upd-')), 'app')
const exe = join(dir, 'Epdf.exe')
const inst = spawnSync(oldInstaller, ['/S', `/D=${dir}`], { stdio: 'ignore' })
if (inst.status !== 0 || !existsSync(exe)) { fail(`old installer exit ${inst.status}`); process.exit(1) }
const before = versionOf(exe)
console.log(`# installed ${before} in ${dir}`)

const runningFromDir = () =>
  ps(`Get-CimInstance Win32_Process -Filter "Name='Epdf.exe'" | Where-Object { $_.ExecutablePath -like '${dir.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`)
    .split(/\s+/).filter(Boolean).map(Number)
const killInstalled = () => { for (const pid of runningFromDir()) try { process.kill(pid) } catch { /* already gone */ } }

// 3. launch and ask for updates
const profile = mkdtempSync(join(tmpdir(), 'epdf-upd-profile-'))
const app = await electron.launch({
  executablePath: exe,
  env: { ...process.env, EPDF_USER_DATA: profile, EPDF_UPDATE_URL: feed, EPDF_UPDATE_TEST_ACCEPT: '1', ELECTRON_RENDERER_URL: '' }
})
const win = await app.firstWindow()
await win.waitForFunction(() => performance.getEntriesByName('epdf:interactive').length > 0, null, { timeout: 30000 })
const closed = new Promise((r) => app.on('close', r))
await app.evaluate(({ Menu }) => {
  const find = (items) => { for (const it of items) { if (it.label === 'Check for Updates…') return it; const f = it.submenu && find(it.submenu.items); if (f) return f } return null }
  const item = find(Menu.getApplicationMenu().items)
  if (!item) throw new Error('menu item not found')
  setTimeout(() => item.click(), 0)
}).catch(() => undefined)

// 4. expected outcome
const settle = await Promise.race([closed.then(() => 'closed'), sleep(tamper ? 45000 : 180000).then(() => 'timeout')])
let ok
if (tamper) {
  // The download must be rejected: the app stays open (an error dialog is auto-dismissed by the test build? it is not,
  // so simply require that the old version is still what is on disk and no newer installer ran).
  await sleep(3000)
  ok = versionOf(exe) === before
  ok = ok && requests.some((r) => r.endsWith('.exe')) // the download really happened and was then rejected
  ok ? pass(`tampered update refused, still ${before}`) : fail(`version is ${versionOf(exe)} after a tampered download (requests: ${requests.join(', ')})`)
  await app.close().catch(() => undefined)
} else {
  console.log(`# app ${settle}`)
  let now = before
  for (let i = 0; i < 120 && now === before; i++) { await sleep(1000); now = versionOf(exe) }
  ok = now.startsWith(wantVersion) // Windows reports 0.1.1 as 0.1.1.0
  ok ? pass(`updated ${before} -> ${now}`) : fail(`still ${now}, expected ${wantVersion}`)
  // the updated app should come back up by itself (only meaningful once the app we launched has exited)
  if (settle === 'closed') {
    let relaunched = []
    for (let i = 0; i < 40 && relaunched.length === 0; i++) { await sleep(1000); relaunched = runningFromDir() }
    relaunched.length ? pass('app relaunched after the update') : console.log('NOTE app did not relaunch by itself')
  }
}
console.log(`# requests: ${requests.join(' | ')}`)
killInstalled()
await sleep(1500)

// 5. uninstall and clean up
const un = spawnSync(join(dir, 'Uninstall Epdf.exe'), ['/currentuser', '/S'], { stdio: 'ignore' })
await sleep(5000)
existsSync(dir) ? fail('install folder left behind') : pass('uninstalled, folder removed')
server.close()
if (!existsSync(join(feedDir, 'latest.yml'))) fail('feed folder changed')
process.exit(process.exitCode ?? 0)
