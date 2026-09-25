export const formatDate = (ms: number): string => {
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

export const formatCount = (n: number): string => n.toLocaleString('en-US')

export const plural = (n: number, one: string, many = `${one}s`): string => `${formatCount(n)} ${n === 1 ? one : many}`
