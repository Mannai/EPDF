import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { _resetFeatureChannels, callFeatureChannel, registerFeatureChannel } from '../../src/main/features/api'

const ctx = { event: {} as never, window: undefined }

beforeEach(() => _resetFeatureChannels())

describe('feature channels', () => {
  it('validates the payload with the feature’s schema before running the handler', async () => {
    let calls = 0
    registerFeatureChannel('demo:double', z.object({ n: z.number() }), ({ n }) => {
      calls++
      return n * 2
    })
    expect(await callFeatureChannel('demo:double', { n: 21 }, ctx)).toBe(42)
    await expect(callFeatureChannel('demo:double', { n: '21' }, ctx)).rejects.toThrow(/Invalid request for demo:double/)
    await expect(callFeatureChannel('demo:double', undefined, ctx)).rejects.toThrow(/Invalid request/)
    expect(calls).toBe(1)
  })

  it('rejects channels nobody registered (the renderer cannot reach arbitrary code)', async () => {
    await expect(callFeatureChannel('fs:readFile', { path: 'C:\\secret' }, ctx)).rejects.toThrow(/Unknown feature channel/)
  })

  it('enforces the <feature>:<action> naming and forbids duplicates', () => {
    expect(() => registerFeatureChannel('nocolon', z.any(), () => 1)).toThrow(/Invalid feature channel name/)
    expect(() => registerFeatureChannel('Bad:Name', z.any(), () => 1)).toThrow(/Invalid feature channel name/)
    registerFeatureChannel('ok:one', z.any(), () => 1)
    expect(() => registerFeatureChannel('ok:one', z.any(), () => 2)).toThrow(/already registered/)
  })

  it('awaits async handlers and propagates their errors', async () => {
    registerFeatureChannel('demo:async', z.any(), async () => 'later')
    registerFeatureChannel('demo:fail', z.any(), async () => {
      throw new Error('nope')
    })
    expect(await callFeatureChannel('demo:async', {}, ctx)).toBe('later')
    await expect(callFeatureChannel('demo:fail', {}, ctx)).rejects.toThrow('nope')
  })
})
