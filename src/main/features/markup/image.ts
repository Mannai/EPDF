/** Validation helpers for the custom image stamp (pure, no Electron imports so they are unit-testable). */

export const MAX_STAMP_IMAGE_BYTES = 25 * 1024 * 1024

/** Identifies PNG and JPEG by their signature (never by file name); anything else is rejected. */
export function sniffImage(bytes: Uint8Array): 'png' | 'jpg' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  return null
}

/** The OS user name for the default annotation author; never throws. */
export function systemUserName(userInfo: () => { username: string }): string {
  try {
    return (userInfo().username ?? '').trim()
  } catch {
    return ''
  }
}
