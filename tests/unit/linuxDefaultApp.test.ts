import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applicationDirs, findDesktopEntry } from '../../src/main/services/linuxDefaultApp'

describe('Linux default PDF app', () => {
  it('looks in the XDG application folders, the user’s first', () => {
    expect(applicationDirs({ XDG_DATA_HOME: '/home/u/.local/share', XDG_DATA_DIRS: '/usr/local/share:/usr/share' })).toEqual([
      join('/home/u/.local/share', 'applications'),
      join('/usr/local/share', 'applications'),
      join('/usr/share', 'applications')
    ])
    expect(applicationDirs({ XDG_DATA_HOME: '/h', XDG_DATA_DIRS: '' }).slice(1)).toEqual([join('/usr/local/share', 'applications'), join('/usr/share', 'applications')])
  })

  it('finds the entry the .deb installs, or one that runs this executable; none for an unintegrated AppImage', () => {
    const files = new Map<string, string>()
    const fs = { exists: (p: string) => files.has(p), read: (p: string) => files.get(p) ?? '' }
    const dirs = ['/home/u/.local/share/applications', '/usr/share/applications']
    expect(findDesktopEntry('/tmp/.mount_Epdf/epdf', dirs, fs)).toBeNull()
    files.set(join('/usr/share/applications', 'Epdf.desktop'), '[Desktop Entry]\nName=Epdf\nExec=/opt/Epdf/epdf %U\n')
    expect(findDesktopEntry('/opt/Epdf/epdf', dirs, fs)).toBe('Epdf.desktop')
    expect(findDesktopEntry('/somewhere/else/other', dirs, fs)).toBeNull()
    files.set(join('/usr/share/applications', 'epdf.desktop'), '[Desktop Entry]\nExec=/opt/Epdf/epdf %U\n')
    expect(findDesktopEntry('/anything', dirs, fs)).toBe('epdf.desktop')
  })
})
