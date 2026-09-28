import { win32 } from 'node:path'
import type { ScanAcquireRequest } from '../../../shared/features/scan'
import type { HelperSpec } from './helper'

/**
 * Windows scanning through WIA (Windows Image Acquisition), the scanner API that ships with Windows. It is driven from
 * PowerShell through the `WIA.DeviceManager` COM object, so nothing is installed. The script below is a FIXED string;
 * the only variable input is a JSON document in the `EPDF_SCAN_PARAMS` environment variable, which the script parses
 * with ConvertFrom-Json (never interpolated into code). The script is passed with `-EncodedCommand`.
 *
 * Output: the line protocol from ./protocol.ts. Pages are saved as PNG (BMP fallback) into a directory the caller owns.
 *
 * NOTE: written against the documented WIA object model and verified only for device enumeration. Scanning, the
 * document feeder and duplex have NOT been run against real hardware.
 */

/** WIA property ids used below (wiadef.h). */
export const WIA_IDS = {
  devName: 7,
  devDescription: 4,
  devVendor: 3,
  itemName: 4098,
  dataType: 4103,
  currentIntent: 6146,
  horizontalResolution: 6147,
  verticalResolution: 6148,
  horizontalStart: 6149,
  verticalStart: 6150,
  horizontalExtent: 6151,
  verticalExtent: 6152,
  maxHorizontalSize: 6165,
  maxVerticalSize: 6166,
  documentHandlingCapabilities: 3086,
  documentHandlingStatus: 3087,
  documentHandlingSelect: 3088,
  pages: 3096
} as const

export const WIA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
$p = $env:EPDF_SCAN_PARAMS | ConvertFrom-Json
function Send($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 8)); [Console]::Out.Flush() }
function HexOf($e) {
  $h = 0
  try { $h = [int]$e.Exception.HResult } catch {}
  if ($h -eq 0) { try { $h = [int]$e.Exception.InnerException.HResult } catch {} }
  '0x{0:X8}' -f ([BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$h), 0))
}
function Fail($e) { Send @{ type = 'error'; hresult = (HexOf $e); message = [string]$e.Exception.Message }; exit 2 }
function FindProp($props, $id) { foreach ($x in $props) { if ($x.PropertyID -eq $id) { return $x } }; return $null }
function GetProp($props, $id) { try { $x = FindProp $props $id; if ($x) { return $x.Value } } catch {}; return $null }
function SetProp($props, $id, $v) { try { $x = FindProp $props $id; if ($x) { $x.Value = $v; return $true } } catch {}; return $false }
function Values($x) {
  $r = @()
  if (-not $x) { return $r }
  try {
    if ($x.SubType -eq 2) { $v = $x.SubTypeValues; for ($i = 1; $i -le $v.Count; $i++) { $r += [int]$v.Item($i) } }
    elseif ($x.SubType -eq 1) { $st = [Math]::Max(1, [int]$x.SubTypeStep); for ($n = [int]$x.SubTypeMin; $n -le [int]$x.SubTypeMax; $n += $st) { $r += $n } }
  } catch {}
  return $r
}
function FindDevice($dm, $id) { foreach ($d in $dm.DeviceInfos) { if ($d.DeviceID -eq $id) { return $d } }; return $null }
function ItemNamed($dev, $pattern) {
  for ($i = 1; $i -le $dev.Items.Count; $i++) {
    $it = $dev.Items.Item($i)
    $nm = [string](GetProp $it.Properties 4098)
    if ($nm -match $pattern) { return $it }
  }
  return $null
}
try {
  try { $dm = New-Object -ComObject WIA.DeviceManager }
  catch { Send @{ type = 'error'; code = 'unavailable'; message = 'Windows Image Acquisition (WIA) is not available on this computer.' }; exit 2 }
  switch ($p.command) {
    'list' {
      $out = @()
      foreach ($d in $dm.DeviceInfos) {
        if ([int]$d.Type -ne 1) { continue }
        $name = [string](GetProp $d.Properties 7)
        if (-not $name) { $name = [string](GetProp $d.Properties 4) }
        if (-not $name) { $name = 'Scanner' }
        $out += @{ id = [string]$d.DeviceID; name = $name; manufacturer = [string](GetProp $d.Properties 3) }
      }
      Send @{ type = 'devices'; devices = @($out) }
      Send @{ type = 'done' }
    }
    'caps' {
      $di = FindDevice $dm $p.deviceId
      if (-not $di) { Send @{ type = 'error'; code = 'not_found'; message = 'not found' }; exit 2 }
      $dev = $di.Connect()
      $cap = GetProp $dev.Properties 3086
      $sources = @()
      $duplex = $false
      $flat = ItemNamed $dev '(?i)flatbed'
      $feed = ItemNamed $dev '(?i)feeder|adf'
      if ($flat) { $sources += 'flatbed' }
      if ($feed) { $sources += 'feeder'; $duplex = $true }
      if ($sources.Count -eq 0) {
        if ($cap -eq $null -or (([int]$cap -band 2) -ne 0)) { $sources += 'flatbed' }
        if ($cap -ne $null -and (([int]$cap -band 1) -ne 0)) { $sources += 'feeder' }
        if ($cap -ne $null -and (([int]$cap -band 4) -ne 0)) { $duplex = $true }
      }
      $item = $flat; if (-not $item) { $item = $feed }; if (-not $item) { $item = $dev.Items.Item(1) }
      $res = @(Values (FindProp $item.Properties 6147))
      $modes = @('color', 'gray', 'bw')
      Send @{ type = 'caps'; resolutions = @($res); colorModes = @($modes); sources = @($sources); duplex = [bool]$duplex }
      Send @{ type = 'done' }
    }
    'scan' {
      $di = FindDevice $dm $p.deviceId
      if (-not $di) { Send @{ type = 'error'; code = 'not_found'; message = 'not found' }; exit 2 }
      $dev = $di.Connect()
      $feeder = ($p.source -eq 'feeder')
      $item = $null
      if ($feeder) { $item = ItemNamed $dev '(?i)feeder|adf' } else { $item = ItemNamed $dev '(?i)flatbed' }
      if (-not $item) { $item = $dev.Items.Item(1) }
      $select = 2; if ($feeder) { $select = 1; if ($p.duplex) { $select = 5 } }
      [void](SetProp $dev.Properties 3088 $select)
      [void](SetProp $item.Properties 3088 $select)
      if ($feeder) { [void](SetProp $dev.Properties 3096 0) }
      $dt = 3; $intent = 1; if ($p.colorMode -eq 'gray') { $dt = 2; $intent = 2 } elseif ($p.colorMode -eq 'bw') { $dt = 0; $intent = 4 }
      [void](SetProp $item.Properties 6146 $intent)
      [void](SetProp $item.Properties 4103 $dt)
      [void](SetProp $item.Properties 6147 ([int]$p.dpi))
      [void](SetProp $item.Properties 6148 ([int]$p.dpi))
      [void](SetProp $item.Properties 6149 0)
      [void](SetProp $item.Properties 6150 0)
      $bw = GetProp $item.Properties 6165
      $bh = GetProp $item.Properties 6166
      if ($bw -and $bh) {
        [void](SetProp $item.Properties 6151 ([int]([double]$bw * [int]$p.dpi / 1000)))
        [void](SetProp $item.Properties 6152 ([int]([double]$bh * [int]$p.dpi / 1000)))
      }
      $fmts = @('{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}', '{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}')
      $operational = @('0x80210002', '0x80210003', '0x80210004', '0x80210005', '0x80210006', '0x80210007', '0x80210008', '0x8021000A', '0x8021000D', '0x80210015', '0x80210016', '0x80210017')
      $fi = 0
      $n = 0
      $stop = $false
      while (-not $stop -and $n -lt [int]$p.maxPages) {
        Send @{ type = 'progress'; message = ('Scanning page {0}' -f ($n + 1)) }
        $img = $null
        try { $img = $item.Transfer($fmts[$fi]) }
        catch {
          $code = HexOf $_
          if ($code -eq '0x80210003' -and $n -gt 0) { $stop = $true }
          elseif ($n -eq 0 -and $fi -eq 0 -and ($operational -notcontains $code)) {
            $fi = 1
            try { $img = $item.Transfer($fmts[$fi]) } catch { Fail $_ }
          }
          else { Fail $_ }
        }
        if ($stop) { break }
        $ext = ([string]$img.FileExtension).TrimStart('.')
        $file = Join-Path $p.dir ('page{0:D3}.{1}' -f ($n + 1), $ext)
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
        $img.SaveFile($file)
        $n++
        Send @{ type = 'page'; index = $n; file = $file; dpi = [int]$p.dpi }
        if (-not $feeder) { break }
        $st = GetProp $dev.Properties 3087
        if ($st -ne $null -and (([int]$st -band 1) -eq 0)) { break }
      }
      Send @{ type = 'done'; pages = $n }
    }
    default { Send @{ type = 'error'; message = 'Unknown command' }; exit 2 }
  }
} catch { Fail $_ }
`

export type WiaCommand =
  | { command: 'list' }
  | { command: 'caps'; deviceId: string }
  | ({ command: 'scan'; dir: string } & Pick<ScanAcquireRequest, 'deviceId' | 'dpi' | 'colorMode' | 'source' | 'duplex' | 'maxPages'>)

/** The `powershell.exe` in System32 (an absolute path, so a PATH entry cannot substitute another program). */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  // A Windows path whatever platform builds it (the command only ever runs on Windows).
  return win32.join(env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** `-EncodedCommand` payload: base64 of the UTF-16LE script text. */
export function encodeScript(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** Builds the process spec: fixed script, parameters only through JSON in the environment. No shell involved. */
export function buildWiaSpec(cmd: WiaCommand, env: NodeJS.ProcessEnv = process.env): HelperSpec {
  return {
    file: powershellPath(env),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeScript(WIA_SCRIPT)],
    env: { ...env, EPDF_SCAN_PARAMS: JSON.stringify(cmd) }
  }
}

/** Standard scan resolutions offered to the user, limited to what the device reports (all of them when it reports none). */
export const STANDARD_DPI = [75, 100, 150, 200, 300, 400, 600, 1200]

export function offeredResolutions(reported: number[]): number[] {
  if (reported.length === 0) return STANDARD_DPI.filter((d) => d <= 600)
  const ok = STANDARD_DPI.filter((d) => reported.includes(d))
  if (ok.length) return ok
  // odd device list (e.g. 96/192/384): offer up to six of the reported values
  const uniq = [...new Set(reported)].sort((a, b) => a - b)
  return uniq.length <= 6 ? uniq : [uniq[0], uniq[Math.floor(uniq.length * 0.25)], uniq[Math.floor(uniq.length * 0.5)], uniq[Math.floor(uniq.length * 0.75)], uniq[uniq.length - 1]]
}
