import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { askForEula, EULA_VERSION, eulaNeedsAcceptance, type EulaAnswer } from '../../src/main/services/eula'

describe('license agreement on first start', () => {
  it('is asked where no installer asked (Linux, macOS), once per agreement version', () => {
    expect(eulaNeedsAcceptance('linux', null, {})).toBe(true)
    expect(eulaNeedsAcceptance('darwin', null, {})).toBe(true)
    expect(eulaNeedsAcceptance('linux', EULA_VERSION, {})).toBe(false)
    expect(eulaNeedsAcceptance('linux', '0.9', {})).toBe(true) // a new version of the terms asks again
    expect(eulaNeedsAcceptance('linux', '1.0', {})).toBe(true) // 1.0 named a person as the licensor; 1.1 names Epdf
    expect(eulaNeedsAcceptance('win32', null, {})).toBe(false) // the Windows installer asked
    expect(eulaNeedsAcceptance('linux', null, { EPDF_ACCEPT_EULA: '1' })).toBe(false) // automated deployment
    expect(eulaNeedsAcceptance('linux', null, { EPDF_ACCEPT_EULA: 'yes' })).toBe(true) // only the exact value
  })

  it('reading the agreement asks again; only "I Agree" remembers; Quit does not start Epdf', async () => {
    const run = async (answers: EulaAnswer[]): Promise<{ ok: boolean; opened: number; remembered: string[] }> => {
      let opened = 0
      const remembered: string[] = []
      const ok = await askForEula({
        ask: async () => answers.shift() ?? 'quit',
        openAgreement: async () => {
          opened++
        },
        remember: (v) => remembered.push(v)
      })
      return { ok, opened, remembered }
    }
    expect(await run(['read', 'read', 'agree'])).toEqual({ ok: true, opened: 2, remembered: [EULA_VERSION] })
    expect(await run(['read', 'quit'])).toEqual({ ok: false, opened: 1, remembered: [] })
    expect(await run(['quit'])).toEqual({ ok: false, opened: 0, remembered: [] })
  })

  it('the version asked for is the version of the agreement text that ships', () => {
    const text = readFileSync(join(__dirname, '../../build/license.txt'), 'utf8')
    expect(/^Version (\S+),/m.exec(text)?.[1]).toBe(EULA_VERSION)
  })
})
