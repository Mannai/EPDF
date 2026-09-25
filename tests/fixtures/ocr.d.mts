export const PAGE_TEXT: string[][]
export const DPI: number
export function rasterizeText(
  lines: { text: string; x: number; y: number; size: number }[],
  W: number,
  H: number,
  opts?: { angle?: number; noise?: number }
): Uint8Array
export function encodeGrayPng(gray: Uint8Array, W: number, H: number): Uint8Array
export function scanPng(texts: string[], wPt?: number, hPt?: number, opts?: { angle?: number; sizePt?: number }): Uint8Array
export function createScan1(): Promise<Uint8Array>
export function createScan3(): Promise<Uint8Array>
export function createScanRotated(rotate?: number): Promise<Uint8Array>
export function createScanCropped(): Promise<Uint8Array>
export function createScanMixed(): Promise<Uint8Array>
export function createScanSkewed(tilt?: number): Promise<Uint8Array>
export function createAll(outDir: string): Promise<string[]>
