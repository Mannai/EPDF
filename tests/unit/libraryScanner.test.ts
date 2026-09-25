import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readWindowsAttributes } from '../../src/main/features/library/attributes'
import { isSkippedDirName, scanFolder } from '../../src/main/features/library/scanner'
import { isPlaceholderAttributes } from '../../src/shared/features/library/placeholder'

let root: string
const touch = (rel: string, content: string | Buffer = '%PDF-1.4\nx'): string => {
  const p = join(root, ...rel.split('/'))
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
  return p
}
const opts = { maxDepth: 20, maxFiles: 10_000 }
const names = (r: Awaited<ReturnType<typeof scanFolder>>): string[] => r.entries.map((e) => `${e.relDir ? e.relDir + '/' : ''}${e.name}`).sort()

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'epdf-scan-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('folder scanner', () => {
  it('finds PDFs recursively (any case), with size, mtime and relative folder; ignores other files', async () => {
    touch('a.pdf')
    touch('sub/b.PDF', 'twelve bytes')
    touch('sub/deep/c.Pdf')
    touch('notes.txt', 'x')
    touch('sub/readme.md', 'x')
    const r = await scanFolder(root, opts)
    expect(r.rootOk).toBe(true)
    expect(names(r)).toEqual(['a.pdf', 'sub/b.PDF', 'sub/deep/c.Pdf'])
    const b = r.entries.find((e) => e.name === 'b.PDF')!
    expect(b).toMatchObject({ size: 12, relDir: 'sub', cloud: false })
    expect(Number.isInteger(b.mtime)).toBe(true)
    expect(b.path).toContain('b.PDF')
    expect(r.note).toBe('')
  })

  it('skips hidden, system and dependency folders', async () => {
    touch('keep.pdf')
    touch('.git/x.pdf')
    touch('.hidden/y.pdf')
    touch('node_modules/z.pdf')
    touch('$RECYCLE.BIN/w.pdf')
    touch('System Volume Information/v.pdf')
    touch('AppData/u.pdf')
    expect(names(await scanFolder(root, opts))).toEqual(['keep.pdf'])
    expect(isSkippedDirName('.cache')).toBe(true)
    expect(isSkippedDirName('Documents')).toBe(false)
  })

  it('caps depth and file count, and says so', async () => {
    touch('a/b/c/d/deep.pdf')
    touch('top.pdf')
    const shallow = await scanFolder(root, { maxDepth: 2, maxFiles: 100 })
    expect(names(shallow)).toEqual(['top.pdf'])
    expect(shallow.depthCapped).toBe(true)
    expect(shallow.note).toMatch(/deeper than 2 levels/)

    for (let i = 0; i < 30; i++) touch(`many/f${i}.pdf`)
    const capped = await scanFolder(root, { maxDepth: 20, maxFiles: 10 })
    expect(capped.entries).toHaveLength(10)
    expect(capped.truncated).toBe(true)
    expect(capped.note).toMatch(/Stopped after 10 files/)
  })

  it('reports a missing or non-folder root instead of throwing', async () => {
    const missing = await scanFolder(join(root, 'nope'), opts)
    expect(missing.rootOk).toBe(false)
    expect(missing.rootError).toMatch(/does not exist/)
    const file = touch('file.pdf')
    expect((await scanFolder(file, opts)).rootOk).toBe(false)
  })

  it('stops promptly when aborted', async () => {
    for (let i = 0; i < 50; i++) touch(`d${i}/f.pdf`)
    const ctl = new AbortController()
    ctl.abort()
    await expect(scanFolder(root, { ...opts, signal: ctl.signal })).rejects.toThrow('Cancelled')
  })

  it('reports progress while scanning', async () => {
    for (let i = 0; i < 450; i++) touch(`p${i % 5}/f${i}.pdf`, 'x')
    const seen: number[] = []
    const r = await scanFolder(root, { ...opts, onProgress: (n) => seen.push(n) })
    expect(r.entries).toHaveLength(450)
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.at(-1)).toBe(450)
  })

  it('never loops on a directory link that points back up, and lists each file once', async () => {
    touch('a/one.pdf')
    try {
      symlinkSync(root, join(root, 'a', 'loop'), 'junction')
    } catch {
      return // links are not available to this user: nothing to test here
    }
    const r = await scanFolder(root, opts)
    expect(names(r)).toEqual(['a/one.pdf'])
    expect(r.skippedLinks).toBeGreaterThanOrEqual(0)
  })

  it('follows a link inside the folder once, and never follows a link out of the folder', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'epdf-outside-'))
    try {
      writeFileSync(join(outside, 'secret.pdf'), '%PDF-1.4')
      mkdirSync(join(outside, 'dir'))
      writeFileSync(join(outside, 'dir', 'also-secret.pdf'), '%PDF-1.4')
      touch('real/inside.pdf')
      try {
        symlinkSync(join(root, 'real'), join(root, 'alias'), 'junction')
        symlinkSync(join(outside, 'dir'), join(root, 'escape'), 'junction')
        symlinkSync(join(outside, 'secret.pdf'), join(root, 'escape.pdf'), 'file')
      } catch {
        return // no permission to create links on this machine
      }
      const r = await scanFolder(root, opts)
      const found = names(r)
      expect(found.some((n) => n.includes('secret'))).toBe(false)
      expect(found.filter((n) => n.endsWith('inside.pdf')).length).toBe(1) // reachable through two paths, listed once
      expect(r.skippedLinks).toBeGreaterThan(0)
      expect(r.note).toMatch(/link/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('marks placeholder suspects as cloud-only only when the attributes say so (Windows), without reading them', async () => {
    if (process.platform !== 'win32') return
    const sparse = touch('cloudish.pdf', '')
    const normal = touch('normal.pdf')
    try {
      execFileSync('fsutil', ['sparse', 'setflag', sparse], { stdio: 'ignore' })
      truncateSync(sparse, 200_000)
    } catch {
      return // fsutil needs privileges here
    }
    const asked: string[] = []
    // Pretend the attribute word of the sparse file is the OneDrive "recall on data access" flag.
    const cloud = await scanFolder(root, {
      ...opts,
      platform: 'win32',
      readAttributes: async (paths) => {
        asked.push(...paths)
        return new Map(paths.map((p) => [p, 0x400000 | 0x20]))
      }
    })
    expect(asked).toHaveLength(1) // only the suspect was looked at, never the normal file
    expect(asked[0].toLowerCase()).toContain('cloudish.pdf')
    expect(cloud.entries.find((e) => e.name === 'cloudish.pdf')!.cloud).toBe(true)
    expect(cloud.entries.find((e) => e.name === 'normal.pdf')!.cloud).toBe(false)

    // The real attribute reader: a sparse local file is not a placeholder.
    const attrs = await readWindowsAttributes([sparse, normal])
    expect(attrs.get(normal)! & 0x20).toBe(0x20)
    expect(isPlaceholderAttributes(attrs.get(sparse)!)).toBe(false)
    const local = await scanFolder(root, { ...opts, platform: 'win32', readAttributes: readWindowsAttributes })
    expect(local.entries.find((e) => e.name === 'cloudish.pdf')!.cloud).toBe(false)

    // Attributes unavailable: err on the safe side.
    const unknown = await scanFolder(root, { ...opts, platform: 'win32', readAttributes: async () => new Map() })
    expect(unknown.entries.find((e) => e.name === 'cloudish.pdf')!.cloud).toBe(true)
  })

  it('reads attribute words with unusual file names (unicode, spaces, quotes) safely', async () => {
    if (process.platform !== 'win32') return
    const p = touch("odd name é日本 '$(calc)' & ;.pdf")
    const attrs = await readWindowsAttributes([p, join(root, 'missing.pdf')])
    expect(attrs.get(p)! & 0x20).toBe(0x20)
    expect(attrs.get(join(root, 'missing.pdf'))).toBeNull()
  })
})
