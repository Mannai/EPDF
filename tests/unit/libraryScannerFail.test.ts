import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// One directory cannot be listed (permissions can't be simulated portably, so the listing fails on purpose).
const unreadable = { path: '' }
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    readdir: ((p: string, ...rest: unknown[]) => {
      if (unreadable.path && String(p) === unreadable.path) return Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
      return (real.readdir as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof real.readdir
  }
})

const { scanFolder } = await import('../../src/main/features/library/scanner')

const root = mkdtempSync(join(tmpdir(), 'epdf-scanfail-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('scanner failure paths', () => {
  it('skips an unreadable folder, keeps scanning the rest, and reports it', async () => {
    mkdirSync(join(root, 'ok'))
    mkdirSync(join(root, 'locked'))
    writeFileSync(join(root, 'ok', 'a.pdf'), '%PDF')
    writeFileSync(join(root, 'locked', 'b.pdf'), '%PDF')
    unreadable.path = join(realpathSync.native(root), 'locked')
    const r = await scanFolder(root, { maxDepth: 10, maxFiles: 100 })
    expect(r.rootOk).toBe(true)
    expect(r.entries.map((e) => e.name)).toEqual(['a.pdf'])
    expect(r.unreadable).toBe(1)
    expect(r.note).toMatch(/1 item could not be read/)
    unreadable.path = ''
  })
})
