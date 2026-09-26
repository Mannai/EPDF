/**
 * Developer tool: refreshes the vendored, patched copy of harfbuzzjs (MIT) in src/shared/text/vendor/harfbuzz and the
 * two WebAssembly modules in resources/text from node_modules/harfbuzzjs (a devDependency).
 *
 *   npm install harfbuzzjs@<version> --save-dev && node scripts/vendor-harfbuzz.mjs
 *
 * Why vendored: harfbuzzjs initialises with a top-level `await` that fetches the WebAssembly relative to the module
 * URL. That cannot work in every place Epdf runs (sandboxed renderer, worker threads, packaged asar), so the app
 * supplies the wasm bytes itself (`initHarfBuzz({ wasmBinary })`). The patch is a few small edits:
 *   1. harfbuzz.js -> harfbuzz.mjs: no `new URL('harfbuzz.wasm', import.meta.url)` and no Node/`import.meta.url` module
 *      loading (the wasm bytes are always passed in, and the glue must also work once bundled to CommonJS).
 *   2. index.mjs: the top-level `init(await createHarfBuzz())` becomes the exported `initHarfBuzz(moduleArg)`.
 *   3. index.d.mts: the matching declaration.
 * Then re-run `node scripts/build-text-manifest.mjs` is NOT needed (fonts unaffected); run the unit tests.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules', 'harfbuzzjs', 'dist')
const dst = join(root, 'src', 'shared', 'text', 'vendor', 'harfbuzz')
mkdirSync(dst, { recursive: true })
const version = JSON.parse(readFileSync(join(root, 'node_modules', 'harfbuzzjs', 'package.json'), 'utf8')).version

let glue = readFileSync(join(src, 'harfbuzz.js'), 'utf8')
const edits = [
  ['return new URL("harfbuzz.wasm",import.meta.url).href', 'return "harfbuzz.wasm"'],
  ['var ENVIRONMENT_IS_NODE=typeof process=="object"&&process.versions?.node&&process.type!="renderer";', 'var ENVIRONMENT_IS_NODE=false;'],
  ['var _scriptName=import.meta.url;', 'var _scriptName="";']
]
for (const [from, to] of edits) {
  if (!glue.includes(from)) throw new Error(`harfbuzzjs glue changed: cannot patch ${from}`)
  glue = glue.replace(from, to)
}
glue =
  `/* harfbuzzjs ${version} (MIT) Emscripten glue. Epdf patch: no import.meta.url / Node module loading: the wasm bytes are always passed in as \`wasmBinary\`. */\n` + glue
writeFileSync(join(dst, 'harfbuzz.mjs'), glue)

let index = readFileSync(join(src, 'index.mjs'), 'utf8')
const init = 'init(await createHarfBuzz());'
if (!index.includes(init)) throw new Error('harfbuzzjs index changed: cannot patch the initialiser')
index = index
  .replace('from "./harfbuzz.js"', 'from "./harfbuzz.mjs"')
  .replace(
    init,
    '/**\n* Epdf patch: harfbuzzjs initialises with a top-level await that fetches the wasm relative to the module,\n* which cannot work in every place Epdf runs (sandboxed renderer, worker threads, asar). The caller supplies the\n* wasm bytes instead: `await initHarfBuzz({ wasmBinary })`.\n*/\nasync function initHarfBuzz(moduleArg = {}) {\n\tinit(await createHarfBuzz({ locateFile: (p) => p, ...moduleArg }));\n}'
  )
  .replace('export { AxisFlags,', 'export { initHarfBuzz, AxisFlags,')
writeFileSync(join(dst, 'index.mjs'), index)

let dts = readFileSync(join(src, 'index.d.mts'), 'utf8')
dts = dts.replace('export { AxisFlags,', 'declare function initHarfBuzz(moduleArg?: { wasmBinary?: ArrayBuffer | Uint8Array; locateFile?: (path: string) => string }): Promise<void>;\nexport { initHarfBuzz, AxisFlags,')
writeFileSync(join(dst, 'index.d.mts'), dts)
copyFileSync(join(src, 'harfbuzz.d.ts'), join(dst, 'harfbuzz.d.mts'))
copyFileSync(join(root, 'node_modules', 'harfbuzzjs', 'LICENSE'), join(dst, 'LICENSE'))

const res = join(root, 'resources', 'text')
mkdirSync(res, { recursive: true })
copyFileSync(join(src, 'harfbuzz.wasm'), join(res, 'harfbuzz.wasm'))
copyFileSync(join(src, 'harfbuzz-subset.wasm'), join(res, 'harfbuzz-subset.wasm'))
console.log(`vendored harfbuzzjs ${version}`)
