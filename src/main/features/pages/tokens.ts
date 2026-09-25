import { randomUUID } from 'node:crypto'

/**
 * Opaque handles for paths the user chose in a native dialog. The renderer only ever holds a token, so it
 * can ask main to "open that saved file" or "show that folder" without ever supplying a path itself.
 */

export interface TokenEntry {
  path: string
  kind: 'file' | 'folder'
}

const MAX_TOKENS = 500
const entries = new Map<string, TokenEntry>()

export function issueToken(entry: TokenEntry): string {
  const token = randomUUID()
  entries.set(token, entry)
  if (entries.size > MAX_TOKENS) entries.delete(entries.keys().next().value as string) // drop the oldest
  return token
}

export const resolveToken = (token: string): TokenEntry | undefined => entries.get(token)

/** Test helper. */
export const _clearTokens = (): void => entries.clear()
