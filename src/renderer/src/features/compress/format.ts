/** "12.4 MB" style sizes and saving percentages for the dialog and the toast. */
export function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2).replace(/0$/, '')} ${units[i]}`
}

/** Whole-number percentage saved, never negative. */
export const savedPercent = (before: number, after: number): number => (before > 0 ? Math.max(0, Math.round(((before - after) / before) * 100)) : 0)

export const summary = (before: number, after: number): string => `${fmtSize(before)} → ${fmtSize(after)}, saved ${savedPercent(before, after)}%`
