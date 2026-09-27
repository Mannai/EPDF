import { afterEach, describe, expect, it, vi } from 'vitest'
import { contextItemsFor, registerCommand, registerContextItems, _resetRegistries } from '../../src/renderer/src/features/api'
import { openContextMenu } from '../../src/renderer/src/components/contextMenu'

const at = { docId: 'd1', pageIndex: 2, numPages: 5, selectionText: 'hello' }

/** Stands in for main: records the menu it was asked to show and "chooses" the item labelled `pick`. */
function fakeMain(pick: string | null): { shown: () => { x: number; y: number; items: { id?: string; label?: string; type?: string; enabled?: boolean; checked?: boolean }[] } } {
  let last: unknown
  ;(globalThis as { window?: unknown }).window = {
    epdf: {
      call: async (channel: string, req: { x: number; y: number; items: { id?: string; label?: string }[] }) => {
        expect(channel).toBe('chrome:contextMenu')
        last = req
        return req.items.find((i) => i.label === pick)?.id ?? null
      }
    }
  }
  return { shown: () => last as ReturnType<ReturnType<typeof fakeMain>['shown']> }
}

afterEach(() => {
  _resetRegistries()
  delete (globalThis as { window?: unknown }).window
})

describe('context menu groups', () => {
  it('orders groups by `order`, separates them, skips empty groups and survives a failing provider', () => {
    registerContextItems('page', 50, () => [{ label: 'Rotate' }])
    registerContextItems('page', 0, (a) => [{ label: `Page ${a.pageIndex + 1}` }])
    registerContextItems('page', 20, () => [])
    registerContextItems('page', 30, () => {
      throw new Error('boom')
    })
    registerContextItems('selection', 10, () => [{ label: 'Highlight' }])
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(contextItemsFor('page', at)).toEqual([{ label: 'Page 3' }, { type: 'separator' }, { label: 'Rotate' }])
    expect(err).toHaveBeenCalledOnce()
    expect(contextItemsFor('selection', at)).toEqual([{ label: 'Highlight' }])
    err.mockRestore()
  })
})

describe('openContextMenu', () => {
  it('tidies separators, marks checkboxes, disables items without an action or with a disabled command, and runs the chosen one', async () => {
    registerCommand({ id: 'x.off', label: 'Off', run: () => undefined, enabled: () => false })
    const ran: string[] = []
    const main = fakeMain('Second')
    const prevented = vi.fn()
    await openContextMenu({ clientX: 10, clientY: 20, preventDefault: prevented }, [
      { type: 'separator' },
      { label: 'First', run: () => void ran.push('first') },
      { type: 'separator' },
      { type: 'separator' },
      { label: 'Second', keys: 'Ctrl+2', run: () => void ran.push('second') },
      { label: 'Toggle', checked: true, run: () => undefined },
      { label: 'No action' },
      { label: 'Disabled command', command: 'x.off' },
      { type: 'separator' }
    ])
    expect(prevented).toHaveBeenCalled()
    const shown = main.shown()
    expect({ x: shown.x, y: shown.y }).toEqual({ x: 10, y: 20 })
    expect(shown.items.map((i) => (i.type === 'separator' ? '—' : `${i.label}${i.enabled ? '' : ' (off)'}${i.type === 'checkbox' ? (i.checked ? ' [x]' : ' [ ]') : ''}`))).toEqual([
      'First',
      '—',
      'Second',
      'Toggle [x]',
      'No action (off)',
      'Disabled command (off)'
    ])
    expect(ran).toEqual(['second'])
  })

  it('does nothing when the menu is dismissed, and shows nothing for an empty menu', async () => {
    const ran: string[] = []
    const main = fakeMain(null)
    await openContextMenu({ clientX: 1, clientY: 1 }, [{ label: 'A', run: () => void ran.push('a') }])
    expect(ran).toEqual([])
    const again = fakeMain('A')
    await openContextMenu({ clientX: 1, clientY: 1 }, [{ type: 'separator' }])
    expect(again.shown()).toBeUndefined()
    expect(main.shown().items).toHaveLength(1)
  })
})
