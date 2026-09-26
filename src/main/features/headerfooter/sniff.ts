import type { PickedSource } from '../../../shared/features/headerfooter'

/** What a picked file really is, by its first bytes (the extension is not trusted). */
export function sniffSource(bytes: Uint8Array): PickedSource['kind'] | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(1024, bytes.length)))
  if (head.includes('%PDF-')) return 'pdf'
  return null
}
