// Builds THIRD-PARTY-NOTICES.txt: the license texts of everything Epdf ships that it did not write.
//  - npm packages bundled into out/ (collected from the module graph of every electron-vite build),
//  - npm packages shipped as-is in node_modules (the `dependencies` of package.json and theirs),
//  - fonts, WebAssembly modules and data files that come with their own license files.
// MIT, BSD and Apache-2.0 all require their license text (and Apache NOTICE files) to go with the app.
// electron-builder adds Electron's own LICENSE and LICENSES.chromium.html next to Epdf.exe by itself.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

// The project root: npm scripts run there (electron-vite bundles its config elsewhere, so import.meta is no help).
const root = process.cwd()
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.\-_].*)?$/i

// Asset folders whose license files cover what ships from them (see extraResources in electron-builder.yml).
const ASSET_LICENSE_DIRS = [
  'resources/fonts',
  'resources/textfonts',
  'resources/text',
  'resources/ocr',
  'src/renderer/public/pdfjs/cmaps',
  'src/renderer/public/pdfjs/iccs',
  'src/renderer/public/pdfjs/standard_fonts',
  'src/renderer/public/pdfjs/wasm',
  'src/renderer/src/features/textedit/fonts',
  'src/shared/text/vendor/harfbuzz'
]

/** Package root directories seen in the module graphs of this build run (main, preload, renderer, workers). */
const bundled = new Set()

function packageRootOf(id) {
  const path = id.replace(/^\0/, '').replace(/[?#].*$/, '').replace(/\\/g, '/')
  const at = path.lastIndexOf('/node_modules/')
  if (at < 0) return null
  const rest = path.slice(at + '/node_modules/'.length).split('/')
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]
  return path.slice(0, at) + '/node_modules/' + name
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Where Node would find `name` when required from inside `fromDir`. */
function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dirname(dir) === dir) return null
  }
}

/** The runtime `dependencies` and everything they pull in: electron-builder copies these into the app. */
function runtimePackages() {
  const seen = new Set()
  const visit = (name, fromDir) => {
    const dir = resolvePackage(name, fromDir)
    if (!dir || seen.has(dir)) return
    seen.add(dir)
    const pkg = readJson(join(dir, 'package.json'))
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(dep, dir)
  }
  for (const dep of Object.keys(readJson(join(root, 'package.json')).dependencies ?? {})) visit(dep, root)
  return seen
}

function licenseFiles(dir) {
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort()
}

function packageSection(dir) {
  const pkg = readJson(join(dir, 'package.json'))
  const license = typeof pkg.license === 'string' ? pkg.license : (pkg.licenses ?? []).map((l) => l.type).join(' OR ')
  const lines = [`${pkg.name} ${pkg.version}`, `License: ${license || 'see below'}`]
  if (pkg.homepage || pkg.repository) {
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
    lines.push(`Source: ${pkg.homepage ?? repo}`)
  }
  const files = licenseFiles(dir)
  if (!files.length) lines.push('', `(The package ships no license file; it is published under ${license || 'an unstated license'}.)`)
  for (const f of files) lines.push('', readFileSync(join(dir, f), 'utf8').trim())
  return { key: `${pkg.name}@${pkg.version}`, text: lines.join('\n'), license }
}

function assetSections() {
  const out = []
  for (const rel of ASSET_LICENSE_DIRS) {
    const dir = join(root, rel)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir).filter((n) => /\.txt$|^licen[cs]e|^ofl/i.test(n))) {
      const file = join(dir, f)
      if (!statSync(file).isFile() || !/licen[cs]e|ofl|copying|notice/i.test(f)) continue
      out.push({ key: `${rel}/${f}`, text: `${rel}/${f}\n\n${readFileSync(file, 'utf8').trim()}` })
    }
  }
  return out
}

const RULE = '='.repeat(100)

export function renderNotices(packageDirs) {
  const seen = new Map()
  for (const dir of packageDirs) {
    if (!existsSync(join(dir, 'package.json'))) continue
    const section = packageSection(dir)
    if (!seen.has(section.key)) seen.set(section.key, section)
  }
  const packages = [...seen.values()].sort((a, b) => a.key.localeCompare(b.key))
  const assets = assetSections()
  const header = [
    'Epdf - third-party notices',
    '',
    'Epdf includes the open-source software and fonts listed below. Each is used under its own license, reproduced',
    'in full. These licenses apply only to those components; Epdf itself is not open source.',
    '',
    'Electron and Chromium: see LICENSE.electron.txt and LICENSES.chromium.html in the Epdf installation folder.',
    '',
    `Part 1: software packages (${packages.length})`,
    ...packages.map((p) => `  ${p.key}  (${p.license || 'see text'})`),
    '',
    `Part 2: fonts, WebAssembly modules and data files (${assets.length} license files)`,
    ...assets.map((a) => `  ${a.key}`)
  ].join('\n')
  return [header, ...packages.map((p) => p.text), ...assets.map((a) => a.text)].join(`\n\n${RULE}\n\n`) + '\n'
}

export function writeNotices(extraPackageDirs = []) {
  const dirs = new Set([...runtimePackages(), ...extraPackageDirs])
  const file = join(root, 'out', 'THIRD-PARTY-NOTICES.txt')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, renderNotices(dirs))
  return { file: relative(root, file), packages: dirs.size }
}

/** Vite plugin: remembers every npm package in the build's module graph and rewrites the notices when it closes. */
export function thirdPartyNotices() {
  return {
    name: 'epdf-third-party-notices',
    apply: 'build',
    generateBundle() {
      for (const id of this.getModuleIds()) {
        const dir = packageRootOf(id)
        if (dir) bundled.add(dir)
      }
    },
    closeBundle() {
      writeNotices(bundled)
    }
  }
}
