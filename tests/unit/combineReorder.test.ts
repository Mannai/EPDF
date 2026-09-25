import { describe, expect, it } from 'vitest'
import { dropIndex, moveBy, moveItem } from '../../src/renderer/src/features/combine/reorder'

describe('combine reordering helpers', () => {
  const abc = ['a', 'b', 'c', 'd']
  it('moves an item to an index', () => {
    expect(moveItem(abc, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(abc, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveItem(abc, 1, 1)).toEqual(abc)
  })
  it('clamps and ignores bad indexes without mutating the input', () => {
    expect(moveItem(abc, 0, 99)).toEqual(['b', 'c', 'd', 'a'])
    expect(moveItem(abc, 2, -5)).toEqual(['c', 'a', 'b', 'd'])
    expect(moveItem(abc, 9, 0)).toEqual(abc)
    expect(abc).toEqual(['a', 'b', 'c', 'd'])
  })
  it('moves one step up or down and stays put at the ends', () => {
    expect(moveBy(abc, 1, -1)).toEqual(['b', 'a', 'c', 'd'])
    expect(moveBy(abc, 1, 1)).toEqual(['a', 'c', 'b', 'd'])
    expect(moveBy(abc, 0, -1)).toEqual(abc)
    expect(moveBy(abc, 3, 1)).toEqual(abc)
  })
  it('computes the landing index of a drop on the upper or lower half of a row', () => {
    // dragging "a" (0) onto the lower half of "c" (2) puts it after c => index 2 once a is removed
    expect(moveItem(abc, 0, dropIndex(0, 2, true))).toEqual(['b', 'c', 'a', 'd'])
    // upper half of "c": before c => index 1
    expect(moveItem(abc, 0, dropIndex(0, 2, false))).toEqual(['b', 'a', 'c', 'd'])
    // dragging "d" (3) onto the upper half of "b" (1) => before b
    expect(moveItem(abc, 3, dropIndex(3, 1, false))).toEqual(['a', 'd', 'b', 'c'])
    expect(moveItem(abc, 3, dropIndex(3, 0, true))).toEqual(['a', 'd', 'b', 'c'])
  })
})
