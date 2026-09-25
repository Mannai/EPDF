export const SECRET: string
export const RASTER: { width: number; height: number; bg: number[]; ink: number[] }
export function rasterPixels(text?: string): Uint8Array
export function rasterJpeg(text?: string, quality?: number): Uint8Array
export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}
export function createProofPdf(secret?: string): Promise<{
  bytes: Uint8Array
  secret: string
  positions: { rawLeft: Box; jpegLeft: Box; vectorArea: Box; invisible: Box }
}>
export function createSharedFormPdf(): Promise<Uint8Array>
