import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, posix, win32 } from 'node:path'
import type { RootKind } from '../../../shared/features/library'

/**
 * One-click folder suggestions: cloud-sync folders and the usual document folders that actually exist on this
 * machine. Everything that touches the machine is injected (`SuggestEnv`), so the detection logic is unit-tested
 * against fake environments; `realEnv()` is the production wiring.
 */

export interface Suggestion {
  key: string
  label: string
  path: string
  kind: RootKind
  cloud: boolean
}

export interface SuggestEnv {
  platform: string
  home: string
  env: Record<string, string | undefined>
  isDir(path: string): boolean
  listDir(path: string): string[]
  readText(path: string): string | null
  /** Electron's well-known folders (documents, downloads, desktop), when available. */
  known?: { documents?: string; downloads?: string; desktop?: string }
}

export function realEnv(known?: SuggestEnv['known']): SuggestEnv {
  return {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    isDir: (p) => {
      try {
        return statSync(p).isDirectory()
      } catch {
        return false
      }
    },
    listDir: (p) => {
      try {
        return readdirSync(p)
      } catch {
        return []
      }
    },
    readText: (p) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
    known
  }
}

const norm = (p: string, win: boolean): string => {
  const s = p.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  return win ? s.toLowerCase() : s
}

/** Reads the folders a Dropbox `info.json` lists ({ personal: { path }, business: { path } }). */
export function dropboxPathsFromInfo(json: string | null): { label: string; path: string }[] {
  if (!json) return []
  try {
    const data = JSON.parse(json) as Record<string, { path?: unknown } | undefined>
    return Object.entries(data)
      .filter(([, v]) => v && typeof v.path === 'string' && (v.path as string).length > 0)
      .map(([k, v]) => ({ label: k === 'personal' ? 'Dropbox' : k === 'business' ? 'Dropbox (business)' : `Dropbox (${k})`, path: v!.path as string }))
  } catch {
    return []
  }
}

export function detectFolders(e: SuggestEnv): Suggestion[] {
  const win = e.platform === 'win32'
  const join = win ? win32.join : posix.join
  const out: Suggestion[] = []
  const seen = new Set<string>()
  const add = (kind: RootKind, label: string, path: string | undefined, cloud: boolean): void => {
    if (!path || !e.isDir(path)) return
    const k = norm(path, win || e.platform === 'darwin')
    if (seen.has(k)) return
    seen.add(k)
    out.push({ key: `${kind}:${k}`, label, path, kind, cloud })
  }
  const home = e.home

  // OneDrive: environment variables (set by the OneDrive client), then folders in the home directory.
  add('onedrive', 'OneDrive', e.env['OneDrive'], true)
  add('onedrive', 'OneDrive (personal)', e.env['OneDriveConsumer'], true)
  add('onedrive', 'OneDrive (work)', e.env['OneDriveCommercial'], true)
  for (const name of e.listDir(home)) {
    if (/^OneDrive(\b|$)/i.test(name)) add('onedrive', name.replace(/^OneDrive\s*-\s*/i, 'OneDrive – ') || 'OneDrive', join(home, name), true)
  }
  if (e.platform === 'darwin') {
    for (const name of e.listDir(join(home, 'Library', 'CloudStorage'))) {
      if (/^OneDrive/i.test(name)) add('onedrive', name.replace(/^OneDrive-/, 'OneDrive – '), join(home, 'Library', 'CloudStorage', name), true)
    }
  }

  // Google Drive for desktop: a virtual drive letter on Windows, ~/Google Drive, CloudStorage on macOS.
  if (win) {
    for (let c = 'D'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      const drive = `${String.fromCharCode(c)}:\\`
      add('gdrive', `Google Drive (${String.fromCharCode(c)}:)`, `${drive}My Drive`, true)
    }
  }
  add('gdrive', 'Google Drive', join(home, 'Google Drive'), true)
  add('gdrive', 'Google Drive', join(home, 'My Drive'), true)
  for (const name of e.listDir(join(home, 'Library', 'CloudStorage'))) {
    if (/^GoogleDrive-/i.test(name)) {
      const base = join(home, 'Library', 'CloudStorage', name)
      add('gdrive', `Google Drive (${name.replace(/^GoogleDrive-/i, '')})`, e.isDir(join(base, 'My Drive')) ? join(base, 'My Drive') : base, true)
    }
  }

  // Dropbox
  add('dropbox', 'Dropbox', join(home, 'Dropbox'), true)
  const infoFiles = [
    e.env['APPDATA'] && join(e.env['APPDATA'], 'Dropbox', 'info.json'),
    e.env['LOCALAPPDATA'] && join(e.env['LOCALAPPDATA'], 'Dropbox', 'info.json'),
    join(home, '.dropbox', 'info.json')
  ].filter((p): p is string => !!p)
  for (const f of infoFiles) for (const d of dropboxPathsFromInfo(e.readText(f))) add('dropbox', d.label, d.path, true)
  for (const name of e.listDir(join(home, 'Library', 'CloudStorage'))) {
    if (/^Dropbox/i.test(name)) add('dropbox', name.replace(/^Dropbox-?/i, 'Dropbox ').trim(), join(home, 'Library', 'CloudStorage', name), true)
  }

  // iCloud Drive
  add('icloud', 'iCloud Drive', join(home, 'iCloudDrive'), true)
  add('icloud', 'iCloud Drive', join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), true)

  // Box
  add('box', 'Box', join(home, 'Box'), true)
  add('box', 'Box', join(home, 'Box Sync'), true)

  // Ordinary document folders
  add('documents', 'Documents', e.known?.documents ?? join(home, 'Documents'), false)
  add('downloads', 'Downloads', e.known?.downloads ?? join(home, 'Downloads'), false)
  add('desktop', 'Desktop', e.known?.desktop ?? join(home, 'Desktop'), false)
  return out
}

/** A friendly label for a folder the user picked by hand. */
export const labelForFolder = (path: string): string => basename(path.replace(/[\\/]+$/, '')) || path
