import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JobContext } from '../../jobs/JobManager'
import { runProcess as defaultRunProcess } from '../../jobs/workerRunner'
import { POWERSHELL_ARGS, powershellPath } from '../../services/windowsTools'

/**
 * HEIC/HEIF -> JPEG through the operating system. No HEIF decoder is bundled: libheif is LGPL, and there is no
 * permissively licensed pure-JS decoder. What was verified on Windows 11 with Electron 44 (Chromium 152) and the
 * "HEIF Image Extensions" installed: `<img>`, `createImageBitmap`, `ImageDecoder` (isTypeSupported('image/heic')
 * is false; 'image/avif' is true) and `nativeImage` all FAIL to decode a real .heic file, so Chromium cannot do it.
 * The OS decoders can: Windows Imaging Component via PowerShell/WPF (needs the free Microsoft HEIF Image Extensions
 * from the Store, plus HEVC Video Extensions for most iPhone photos) and macOS `sips` (built in). On Linux we try
 * `heif-convert` / ImageMagick if installed. Otherwise the user gets an explanatory message.
 */

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
$in = $env:EPDF_HEIC_IN
$out = $env:EPDF_HEIC_OUT
$fs = [System.IO.File]::OpenRead($in)
try {
  $dec = [System.Windows.Media.Imaging.BitmapDecoder]::Create($fs, [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat, [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
  $enc = New-Object System.Windows.Media.Imaging.JpegBitmapEncoder
  $enc.QualityLevel = 92
  $enc.Frames.Add($dec.Frames[0])
  $o = [System.IO.File]::Create($out)
  try { $enc.Save($o) } finally { $o.Dispose() }
} finally { $fs.Dispose() }
`

export function heicHelp(platform: NodeJS.Platform): string {
  if (platform === 'win32')
    return 'Windows needs the free “HEIF Image Extensions” (and, for most iPhone photos, the “HEVC Video Extensions”) from the Microsoft Store to read HEIC pictures. Install them, or convert the picture to JPEG first.'
  if (platform === 'darwin') return 'macOS could not read this HEIC picture. Open it in Preview and export it as JPEG, then try again.'
  if (platform === 'linux')
    return 'Reading HEIC pictures on Linux needs the “heif-convert” tool (libheif-examples) or ImageMagick with HEIF support. Install one of them, or convert the picture to JPEG first.'
  return 'This computer cannot read HEIC pictures. Convert the picture to JPEG first.'
}

export interface HeicCommand {
  file: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

/** The command that converts `input` to `output` (JPEG) on this platform. Paths are passed as separate arguments or environment variables, never spliced into a script. */
export function heicCommands(platform: NodeJS.Platform, input: string, output: string, env: NodeJS.ProcessEnv = process.env): HeicCommand[] {
  if (platform === 'win32') {
    const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')
    return [
      {
        file: powershellPath(env),
        args: [...POWERSHELL_ARGS, '-EncodedCommand', encoded],
        env: { ...env, EPDF_HEIC_IN: input, EPDF_HEIC_OUT: output }
      }
    ]
  }
  if (platform === 'darwin') return [{ file: '/usr/bin/sips', args: ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', input, '--out', output] }]
  return [
    { file: 'heif-convert', args: ['-q', '92', input, output] },
    { file: 'magick', args: [input, '-quality', '92', output] },
    { file: 'convert', args: [input, '-quality', '92', output] }
  ]
}

export class HeicError extends Error {}

export interface HeicJob {
  inputPath: string
  inputName: string
  ctx: JobContext
  platform?: NodeJS.Platform
  tempRoot?: string
  runProcess?: typeof defaultRunProcess
}

/** Decodes a HEIC/HEIF file to JPEG bytes with the OS decoder; temp files are always removed. */
export async function heicToJpeg(j: HeicJob): Promise<Uint8Array> {
  const platform = j.platform ?? process.platform
  const run = j.runProcess ?? defaultRunProcess
  const root = await mkdtemp(join(j.tempRoot ?? tmpdir(), 'epdf-heic-'))
  try {
    const inDir = join(root, 'in')
    await mkdir(inDir)
    const input = join(inDir, 'picture.heic') // neutral name: the original name never reaches a command line
    const output = join(root, 'picture.jpg')
    await copyFile(j.inputPath, input)
    let lastErr = ''
    let sawTool = false
    for (const cmd of heicCommands(platform, input, output)) {
      try {
        await run(cmd.file, cmd.args, j.ctx, { env: cmd.env, timeout: 120_000 })
        sawTool = true
        const bytes = new Uint8Array(await readFile(output))
        if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return bytes
        lastErr = 'the converter produced no picture'
      } catch (err) {
        if (j.ctx.signal.aborted) throw new Error('Cancelled')
        const msg = err instanceof Error ? err.message : String(err)
        if (!/ENOENT|not found|is not recognized/i.test(msg)) sawTool = true
        lastErr = msg
      }
    }
    throw new HeicError(`“${j.inputName}” could not be converted: ${sawTool ? 'this computer’s HEIC decoder rejected the file' : 'no HEIC decoder was found'}. ${heicHelp(platform)}${lastErr && process.env['EPDF_DEBUG'] ? ` (${lastErr.slice(0, 200)})` : ''}`)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
  }
}
