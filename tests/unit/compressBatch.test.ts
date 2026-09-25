import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, dialog: {} }))

import { BatchReadRequestSchema, BatchWriteRequestSchema } from '../../src/shared/features/compress'
import { issue, readPicked, writeReduced } from '../../src/main/features/compress/batch'

describe('batch mode: file access goes through tokens and never overwrites', () => {
  it('reads a chosen file by token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epdf-batch-'))
    const path = join(dir, 'Report.pdf')
    writeFileSync(path, 'hello')
    const r = await readPicked(issue(path))
    expect(r.name).toBe('Report.pdf')
    expect(Buffer.from(r.bytes).toString()).toBe('hello')
  })

  it('unknown tokens and vanished files are refused with readable messages', async () => {
    await expect(readPicked('not-a-real-token-at-all')).rejects.toThrow(/no longer available/)
    const dir = mkdtempSync(join(tmpdir(), 'epdf-batch-'))
    const t = issue(join(dir, 'gone.pdf'))
    await expect(readPicked(t)).rejects.toThrow(/could not be found/)
    await expect(writeReduced('unknown-token-xyz', new Uint8Array(1))).rejects.toThrow(/no longer available/)
  })

  it('writes "<name> (reduced).pdf" next to the original, then (reduced 2), (reduced 3)...; the original is untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epdf-batch-'))
    const src = join(dir, 'Annual Report.pdf')
    writeFileSync(src, 'ORIGINAL')
    const token = issue(src)
    const a = await writeReduced(token, new Uint8Array([1, 2, 3]))
    const b = await writeReduced(token, new Uint8Array([4, 5, 6, 7]))
    expect(a).toEqual({ name: 'Annual Report (reduced).pdf', size: 3 })
    expect(b).toEqual({ name: 'Annual Report (reduced 2).pdf', size: 4 })
    expect(Array.from(readFileSync(join(dir, a.name)))).toEqual([1, 2, 3])
    expect(Array.from(readFileSync(join(dir, b.name)))).toEqual([4, 5, 6, 7])
    expect(readFileSync(src, 'utf8')).toBe('ORIGINAL')
  })

  it('an existing "(reduced)" file is never clobbered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epdf-batch-'))
    const src = join(dir, 'a.pdf')
    writeFileSync(src, 'x')
    writeFileSync(join(dir, 'a (reduced).pdf'), 'KEEP ME')
    const r = await writeReduced(issue(src), new Uint8Array([9]))
    expect(r.name).toBe('a (reduced 2).pdf')
    expect(readFileSync(join(dir, 'a (reduced).pdf'), 'utf8')).toBe('KEEP ME')
    expect(existsSync(join(dir, 'a (reduced 2).pdf'))).toBe(true)
  })

  it('channel payloads are validated (token shape, bytes)', () => {
    expect(BatchReadRequestSchema.safeParse({ token: 'short' }).success).toBe(false)
    expect(BatchReadRequestSchema.safeParse({ token: '0123456789abcdef' }).success).toBe(true)
    expect(BatchWriteRequestSchema.safeParse({ token: '0123456789abcdef', bytes: 'not bytes' }).success).toBe(false)
    expect(BatchWriteRequestSchema.safeParse({ token: '0123456789abcdef', bytes: new Uint8Array(2) }).success).toBe(true)
    expect(BatchReadRequestSchema.safeParse({ token: '0123456789abcdef', path: 'C:\\evil' }).success).toBe(true) // extra keys ignored: paths are never read
  })
})
