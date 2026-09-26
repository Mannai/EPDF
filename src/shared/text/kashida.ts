import type { Line } from './types'

/**
 * Arabic justification by elongation (kashida). Placeholder until implemented: returns 0 = nothing stretched,
 * so justification falls back to widening the spaces.
 */
export function kashidaJustify(_line: Line, _extra: number): number {
  return 0
}
