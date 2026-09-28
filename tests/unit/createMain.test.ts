import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractVerb, parseVerb } from '../../src/main/features/create/argv'
import { heicCommands, heicHelp, heicToJpeg } from '../../src/main/features/create/heic'
import { LibreOfficeTimeout, buildSofficeArgs, convertWithLibreOffice, discoverSoffice, notInstalledMessage, toolCommand, wellKnownSofficePaths } from '../../src/main/features/create/libreoffice'
import { SourceRegistry, convertAll, convertSource, describeFile, uniquePdfPath, type PipelineDeps, type Source } from '../../src/main/features/create/pipeline'
import { runOp, type PdfResult, type ProbeResult, type WorkerRequest } from '../../src/main/features/create/workerOps'
import { classifyName, fileNameForUrl, normalizeWebUrl, safeFileBase } from '../../src/shared/features/create'
import { makeFakeJpeg, makePng, makeTiff, solid } from '../support/images'
import { makePdf } from '../support/pdfs'
import { readPdf } from '../support/pdfText'

const STUB = resolve('tests/fixtures/stub-soffice.mjs')
const ctx = (signal: AbortSignal = new AbortController().signal) => ({ signal, progress: () => undefined })

let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'epdf-unit-'))
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

describe('web address validation', () => {
  it('adds https:// when the scheme is missing and keeps http(s) as typed', () => {
    expect(normalizeWebUrl('example.com')).toEqual({ ok: true, url: 'https://example.com/' })
    expect(normalizeWebUrl('  www.example.com/path?q=1#x ')).toEqual({ ok: true, url: 'https://www.example.com/path?q=1#x' })
    expect(normalizeWebUrl('http://127.0.0.1:8080/a')).toEqual({ ok: true, url: 'http://127.0.0.1:8080/a' })
    expect(normalizeWebUrl('localhost:3000')).toEqual({ ok: true, url: 'https://localhost:3000/' })
    expect(normalizeWebUrl('HTTPS://Example.COM')).toEqual({ ok: true, url: 'https://example.com/' })
  })
  it('refuses everything that is not a web address', () => {
    for (const bad of ['file:///C:/secret.txt', 'javascript:alert(1)', 'data:text/html,<script>1</script>', 'ftp://example.com/x', 'about:blank', 'chrome://settings', 'view-source:https://a.com', 'blob:https://a.com/1', 'epdf-app://x/index.html']) {
      const r = normalizeWebUrl(bad)
      expect(r.ok, bad).toBe(false)
    }
    expect(normalizeWebUrl('')).toMatchObject({ ok: false })
    expect(normalizeWebUrl('two words.com')).toMatchObject({ ok: false })
    expect(normalizeWebUrl('http://')).toMatchObject({ ok: false })
    expect(normalizeWebUrl('a'.repeat(3000))).toMatchObject({ ok: false })
    expect(normalizeWebUrl('https://exa\nmple.com')).toMatchObject({ ok: false })
  })
  it('derives file-name-safe names', () => {
    expect(fileNameForUrl('https://www.example.com/a/b')).toBe('example.com')
    expect(safeFileBase('a<b>:c/d\\e|f?g*h.')).toBe('a_b_c_d_e_f_g_h')
    expect(safeFileBase('   ', 'Fallback')).toBe('Fallback')
  })
  it('classifies files by extension', () => {
    expect(classifyName('a.PDF')).toBe('pdf')
    expect(classifyName('scan.TIFF')).toBe('tiff')
    expect(classifyName('photo.jpeg')).toBe('image')
    expect(classifyName('IMG_1.HEIC')).toBe('heic')
    expect(classifyName('report.docx')).toBe('office')
    expect(classifyName('data.csv')).toBe('office')
    expect(classifyName('archive.zip')).toBeNull()
    expect(classifyName('noext')).toBeNull()
  })
})

describe('command-line verbs', () => {
  it('extracts --convert-to-pdf and its files, removing them from argv in place', () => {
    // An absolute path for this platform stays as it is; a relative one is resolved against the working directory.
    const [abs, cwd] = process.platform === 'win32' ? ['C:\\a b\\one.docx', 'C:\\work'] : ['/a b/one.docx', '/work']
    const argv = ['epdf.exe', '.', '--convert-to-pdf', abs, 'two.png', '--new-window']
    const v = extractVerb(argv, cwd)
    expect(v).toEqual({ verb: 'convert', files: [abs, resolve(cwd, 'two.png')] })
    expect(argv).toEqual(['epdf.exe', '.', '--new-window'])
  })
  it('extracts --combine, is case-insensitive and stops at the next option', () => {
    const argv = ['epdf', '--Combine', '/x/a.pdf', '/x/b.pdf', '--other', '/x/c.pdf']
    expect(extractVerb(argv, '/')).toEqual({ verb: 'combine', files: ['/x/a.pdf', '/x/b.pdf'] })
    expect(argv).toEqual(['epdf', '--other', '/x/c.pdf'])
  })
  it('leaves argv alone when there is no verb, and only takes the first verb', () => {
    const a = ['epdf', 'doc.pdf']
    expect(extractVerb(a)).toBeNull()
    expect(a).toEqual(['epdf', 'doc.pdf'])
    const b = ['epdf', '--combine', 'a.pdf', '--convert-to-pdf', 'b.png']
    expect(parseVerb(b, '/w').verb?.verb).toBe('combine')
    expect(parseVerb(b, '/w').rest).toEqual(['epdf', '--convert-to-pdf', 'b.png'])
    expect(b).toHaveLength(5) // parseVerb does not mutate
  })
  it('keeps hostile-looking names intact as data', () => {
    const argv = ['epdf', '--convert-to-pdf', 'a b; calc.docx', '--evil.docx']
    const v = extractVerb(argv, '/w')!
    expect(v.files).toEqual([resolve('/w', 'a b; calc.docx')])
    expect(argv).toEqual(['epdf', '--evil.docx'])
  })
  it('handles a verb with no files', () => {
    const argv = ['epdf', '--combine']
    expect(extractVerb(argv)).toEqual({ verb: 'combine', files: [] })
    expect(argv).toEqual(['epdf'])
  })
})

describe('LibreOffice engine', () => {
  it('builds an argument array with a per-job profile and an absolute input, never a shell string', () => {
    const args = buildSofficeArgs({ profileDir: join(work, 'profile dir'), outDir: join(work, 'out'), inputPath: join(work, 'in', 'document.docx') })
    expect(args[0]).toMatch(/^-env:UserInstallation=file:\/\/\/.*profile%20dir$/)
    expect(args).toEqual(expect.arrayContaining(['--headless', '--convert-to', 'pdf', '--outdir', join(work, 'out')]))
    expect(args[args.length - 1]).toBe(join(work, 'in', 'document.docx'))
    expect(args.every((a) => typeof a === 'string')).toBe(true)
  })

  it('discovers LibreOffice via the tool lookup first, then well-known locations, and can be restricted', () => {
    const exists = (p: string): boolean => p.includes('LibreOffice')
    expect(discoverSoffice({ resolveTool: () => 'C:\\tools\\soffice.exe', exists })).toBe('C:\\tools\\soffice.exe')
    expect(discoverSoffice({ resolveTool: () => null, platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, exists })).toBe(join('C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe'))
    expect(discoverSoffice({ resolveTool: () => null, platform: 'win32', env: { EPDF_DISABLE_SOFFICE_DISCOVERY: '1' }, exists })).toBeNull()
    expect(discoverSoffice({ resolveTool: () => null, platform: 'darwin', env: {}, exists: (p) => p.startsWith('/Applications/LibreOffice.app') })).toBe('/Applications/LibreOffice.app/Contents/MacOS/soffice')
    expect(wellKnownSofficePaths('linux', {})).toContain('/usr/bin/soffice')
    expect(notInstalledMessage('Converting Office documents')).toMatch(/needs LibreOffice, which is not installed.*built-in converter/)
  })

  it('runs scripts (the test stub) with Electron/Node, and real tools directly', () => {
    expect(toolCommand('C:\\x\\soffice.exe').file).toBe('C:\\x\\soffice.exe')
    const c = toolCommand(STUB)
    expect(c.file).toBe(process.execPath)
    expect(c.args).toEqual([STUB])
    expect(c.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  const run = (over: Partial<Parameters<typeof convertWithLibreOffice>[0]> & { env?: Record<string, string> }) => {
    const { env, ...rest } = over
    const before = { ...process.env }
    Object.assign(process.env, env)
    return convertWithLibreOffice({ soffice: STUB, inputPath: join(work, 'input.txt'), inputName: 'input.txt', ctx: ctx(), tempRoot: work, ...rest }).finally(() => {
      for (const k of Object.keys(env ?? {})) if (before[k] === undefined) delete process.env[k]
    })
  }
  const tempDirs = (): string[] => readdirSync(work).filter((n) => n.startsWith('epdf-lo-'))

  it('converts through the stub, uses a neutral file name and a private profile, and removes every temp file', async () => {
    writeFileSync(join(work, 'a b; calc --evil.txt'), 'Hello from a hostile name')
    const log = join(work, 'stub.log')
    const bytes = await run({ inputPath: join(work, 'a b; calc --evil.txt'), inputName: 'a b; calc --evil.txt', env: { EPDF_STUB_LOG: log } })
    const { pages } = await readPdf(bytes)
    expect(pages[0].text).toContain('STUB:Hello from a hostile name')
    const call = JSON.parse(readFileSync(log, 'utf8').trim())
    expect(call.argv.join(' ')).not.toContain('calc')
    expect(call.argv.join(' ')).not.toContain('--evil')
    expect(call.argv.some((a: string) => a.startsWith('-env:UserInstallation=file:///'))).toBe(true)
    expect(call.argv[call.argv.length - 1]).toMatch(/document\.txt$/)
    expect(tempDirs()).toEqual([])
  })

  it('handles unicode file names and unknown extensions', async () => {
    writeFileSync(join(work, 'Résumé 履歴書.rtf'), '{\\rtf1 hi}')
    const bytes = await run({ inputPath: join(work, 'Résumé 履歴書.rtf'), inputName: 'Résumé 履歴書.rtf' })
    expect((await readPdf(bytes)).pages).toHaveLength(1)
    writeFileSync(join(work, 'weird'), 'x')
    await run({ inputPath: join(work, 'weird'), inputName: 'weird' })
    expect(tempDirs()).toEqual([])
  })

  it('reports tool failures and missing output with the file name, and cleans up', async () => {
    writeFileSync(join(work, 'input.txt'), 'x')
    await expect(run({ env: { EPDF_STUB_MODE: 'fail' } })).rejects.toThrow(/LibreOffice could not convert “input\.txt”.*could not be loaded/)
    await expect(run({ env: { EPDF_STUB_MODE: 'nopdf' } })).rejects.toThrow(/produced no PDF for “input\.txt”/)
    expect(tempDirs()).toEqual([])
  })

  it('kills the tool after the hard timeout', async () => {
    writeFileSync(join(work, 'input.txt'), 'x')
    const t0 = Date.now()
    await expect(run({ timeoutMs: 400, env: { EPDF_STUB_MODE: 'sleep', EPDF_STUB_SLEEP_MS: '30000' } })).rejects.toBeInstanceOf(LibreOfficeTimeout)
    expect(Date.now() - t0).toBeLessThan(10000)
    expect(tempDirs()).toEqual([])
  })

  it('stops promptly when cancelled', async () => {
    writeFileSync(join(work, 'input.txt'), 'x')
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 500)
    const t0 = Date.now()
    await expect(run({ ctx: ctx(ac.signal), env: { EPDF_STUB_MODE: 'sleep', EPDF_STUB_SLEEP_MS: '30000' } })).rejects.toThrow('Cancelled')
    expect(Date.now() - t0).toBeLessThan(10000)
    expect(tempDirs()).toEqual([])
  })

  it('explains a missing executable', async () => {
    writeFileSync(join(work, 'input.txt'), 'x')
    await expect(run({ soffice: join(work, 'no-such-soffice.exe') })).rejects.toThrow(/needs LibreOffice, which is not installed/)
  })
})

describe('HEIC through the operating system', () => {
  it('never puts file names into a script: Windows uses environment variables, macOS and Linux argument arrays', () => {
    const [win] = heicCommands('win32', 'C:\\t\\in\\picture.heic', 'C:\\t\\picture.jpg', { SystemRoot: 'C:\\Windows' })
    expect(win.file).toMatch(/powershell\.exe$/)
    expect(win.args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-EncodedCommand']))
    expect(win.args.join(' ')).not.toContain('picture.heic')
    expect(win.env).toMatchObject({ EPDF_HEIC_IN: 'C:\\t\\in\\picture.heic', EPDF_HEIC_OUT: 'C:\\t\\picture.jpg' })
    const [mac] = heicCommands('darwin', '/t/in.heic', '/t/out.jpg')
    expect(mac).toEqual({ file: '/usr/bin/sips', args: ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', '/t/in.heic', '--out', '/t/out.jpg'] })
    expect(heicCommands('linux', '/t/in.heic', '/t/out.jpg').map((c) => c.file)).toEqual(['heif-convert', 'magick', 'convert'])
    expect(heicHelp('win32')).toMatch(/HEIF Image Extensions/)
  })

  it('returns the decoder’s JPEG and cleans up', async () => {
    writeFileSync(join(work, 'p.heic'), 'x')
    const jpeg = makeFakeJpeg(10, 10)
    const bytes = await heicToJpeg({
      inputPath: join(work, 'p.heic'),
      inputName: 'p.heic',
      ctx: ctx(),
      platform: 'linux',
      tempRoot: work,
      runProcess: async (_file, args) => {
        writeFileSync(args[args.length - 1], jpeg)
        return { stdout: '', stderr: '' }
      }
    })
    expect(Array.from(bytes)).toEqual(Array.from(jpeg))
    expect(readdirSync(work).filter((n) => n.startsWith('epdf-heic-'))).toEqual([])
  })

  it('fails with a helpful message when no decoder exists or it rejects the file', async () => {
    writeFileSync(join(work, 'p.heic'), 'x')
    const base = { inputPath: join(work, 'p.heic'), inputName: 'photo.heic', ctx: ctx(), tempRoot: work }
    await expect(heicToJpeg({ ...base, platform: 'linux', runProcess: async () => Promise.reject(new Error('spawn heif-convert ENOENT')) })).rejects.toThrow(/“photo\.heic” could not be converted: no HEIC decoder was found.*heif-convert/)
    await expect(
      heicToJpeg({ ...base, platform: 'win32', runProcess: async () => Promise.reject(new Error('powershell failed: No imaging component suitable to complete this operation was found.')) })
    ).rejects.toThrow(/decoder rejected the file.*HEIF Image Extensions/)
    expect(readdirSync(work).filter((n) => n.startsWith('epdf-heic-'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------

const fontsDir = resolve('resources/fonts')
const directRun = async (req: WorkerRequest): Promise<PdfResult | ProbeResult> => (await runOp(req as never)) as PdfResult | ProbeResult
const makeDeps = (over: Partial<PipelineDeps> = {}): PipelineDeps => ({
  fontsDir,
  page: { width: 612, height: 792 },
  run: (req) => directRun(req),
  heicToJpeg: async () => makeFakeJpeg(80, 60),
  findSoffice: () => null,
  convertWithLibreOffice: async () => new Uint8Array(await (await PDFDocument.create()).save()),
  ...over
})
const src = async (name: string, bytes: Uint8Array | string): Promise<Source> => {
  const path = join(work, name)
  mkdirSync(work, { recursive: true })
  writeFileSync(path, bytes)
  const d = await describeFile(path)
  if ('skip' in d) throw new Error(d.skip)
  return new SourceRegistry().register(d)
}

describe('conversion pipeline', () => {
  it('describes files and rejects unsupported ones', async () => {
    const png = join(work, 'a.png')
    writeFileSync(png, makePng(2, 2, solid(0, 0, 0)))
    expect(await describeFile(png)).toMatchObject({ name: 'a.png', kind: 'image', pages: 1 })
    expect(await describeFile(join(work, 'x.exe'))).toEqual({ skip: 'This type of file cannot be turned into a PDF.' })
    expect(await describeFile(join(work, 'missing.png'))).toEqual({ skip: 'The file could not be read.' })
  })

  it('converts images, TIFFs, HEIC (via the OS decoder) and Office text through the right converters', async () => {
    const deps = makeDeps()
    const opts = { images: { pageSize: 'image' as const }, engine: 'builtin' as const }
    const png = await convertSource(await src('p.png', makePng(50, 40, solid(1, 2, 3))), deps, opts, ctx())
    expect((await PDFDocument.load(await bytesOf(png))).getPage(0).getSize()).toEqual({ width: 50, height: 40 })
    const tif = await convertSource(await src('t.tif', makeTiff([{ w: 10, h: 10, px: solid(9, 9, 9) }, { w: 20, h: 10, px: solid(9, 9, 9) }])), deps, opts, ctx())
    expect(tif.pages).toBe(2)
    const heic = await convertSource(await src('h.heic', 'not really heic'), deps, opts, ctx())
    expect((await PDFDocument.load(await bytesOf(heic))).getPage(0).getSize()).toEqual({ width: 80, height: 60 })
    const txt = await convertSource(await src('n.txt', 'Hello pipeline'), deps, opts, ctx())
    expect((await readPdf(await bytesOf(txt))).pages[0].text).toBe('Hello pipeline')
    const pdfPath = await src('d.pdf', await makePdf({ pages: 3 }))
    pdfPath.pages = 3
    const pass = await convertSource(pdfPath, deps, opts, ctx())
    expect(pass.pdf).toEqual({ path: pdfPath.path })
  })

  it('refuses legacy binary Office files under the built-in engine and asks for LibreOffice when it is chosen but missing', async () => {
    const deps = makeDeps()
    const doc = await src('old.doc', 'binary')
    await expect(convertSource(doc, deps, { images: { pageSize: 'image' }, engine: 'builtin' }, ctx())).rejects.toThrow(/old binary \.doc file.*save it as \.docx/)
    await expect(convertSource(doc, deps, { images: { pageSize: 'image' }, engine: 'libreoffice' }, ctx())).rejects.toThrow(/needs LibreOffice, which is not installed/)
    const viaLo = makeDeps({ findSoffice: () => STUB, convertWithLibreOffice: async () => new Uint8Array(await (async () => { const d = await PDFDocument.create(); d.addPage([100, 100]); return d.save() })()) })
    const r = await convertSource(doc, viaLo, { images: { pageSize: 'image' }, engine: 'libreoffice' }, ctx())
    expect('bytes' in r.pdf).toBe(true)
  })

  it('convertAll reports each failure but keeps going, and stops on cancel', async () => {
    const deps = makeDeps()
    const good = await src('ok.txt', 'fine')
    const bad = await src('bad.png', 'this is not a png at all')
    const out = await convertAll([bad, good], deps, { images: { pageSize: 'image' }, engine: 'builtin' }, ctx())
    expect(out.ok.map((o) => o.converted.source.name)).toEqual(['ok.txt'])
    expect(out.failed).toEqual([{ name: 'bad.png', error: expect.stringContaining('“bad.png” could not be converted') }])
    const ac = new AbortController()
    ac.abort()
    await expect(convertAll([good], deps, { images: { pageSize: 'image' }, engine: 'builtin' }, ctx(ac.signal))).rejects.toThrow('Cancelled')
  })

  it('makes unique, safe output names', () => {
    const existing = new Set([join('/o', 'Report.pdf').toLowerCase(), join('/o', 'Report (2).pdf').toLowerCase()])
    const exists = (p: string): boolean => existing.has(p.toLowerCase())
    expect(uniquePdfPath('/o', 'Report', exists)).toBe(join('/o', 'Report (3).pdf'))
    const taken = new Set<string>()
    expect(uniquePdfPath('/o', 'New', exists, taken)).toBe(join('/o', 'New.pdf'))
    expect(uniquePdfPath('/o', 'New', exists, taken)).toBe(join('/o', 'New (2).pdf'))
    expect(uniquePdfPath('/o', 'a<b>:c', exists)).toBe(join('/o', 'a_b_c.pdf'))
  })
})

async function bytesOf(c: { pdf: { path: string } | { bytes: Uint8Array } }): Promise<Uint8Array> {
  return 'bytes' in c.pdf ? c.pdf.bytes : new Uint8Array(readFileSync(c.pdf.path))
}

describe('worker operations', () => {
  it('probes PDFs (page counts, encrypted files)', async () => {
    writeFileSync(join(work, 'a.pdf'), await makePdf({ pages: 4 }))
    writeFileSync(join(work, 'junk.pdf'), 'not a pdf')
    const r = (await runOp({ op: 'probe', files: [{ path: join(work, 'a.pdf'), name: 'a.pdf' }, { path: join(work, 'junk.pdf'), name: 'junk.pdf' }] })) as ProbeResult
    expect(r[0]).toEqual({ pages: 4 })
    expect(r[1]).toMatchObject({ problem: expect.stringContaining('damaged') })
  })

  it('merges files with page ranges resolved after loading, and reports bad ranges by file name', async () => {
    writeFileSync(join(work, 'a.pdf'), await makePdf({ pages: 5, label: 'A' }))
    const ok = (await runOp({ op: 'merge', items: [{ name: 'a.pdf', path: join(work, 'a.pdf'), range: '4-, 1' }], bookmarks: false })) as PdfResult
    expect(ok.pages).toBe(3)
    await expect(runOp({ op: 'merge', items: [{ name: 'a.pdf', path: join(work, 'a.pdf'), range: '9' }], bookmarks: false })).rejects.toThrow(/Pages for “a\.pdf”: This file has only 5 pages/)
  })
})
