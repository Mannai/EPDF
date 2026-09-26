import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '', disableHardwareAcceleration: () => undefined } }))
const { isRemoteSession } = await import('../../src/main/services/gpu')

describe('hardware acceleration default', () => {
  it('treats a Windows Remote Desktop session as remote', () => {
    expect(isRemoteSession({ SESSIONNAME: 'RDP-Tcp#0' }, 'win32')).toBe(true)
    expect(isRemoteSession({ SESSIONNAME: 'rdp-tcp#12' }, 'win32')).toBe(true)
  })
  it('treats the local console (and other platforms) as local', () => {
    expect(isRemoteSession({ SESSIONNAME: 'Console' }, 'win32')).toBe(false)
    expect(isRemoteSession({}, 'win32')).toBe(false)
    expect(isRemoteSession({ SESSIONNAME: 'RDP-Tcp#0' }, 'darwin')).toBe(false)
  })
})
