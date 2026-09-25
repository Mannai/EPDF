import { resolve } from 'node:path'
import type { IndexEngine } from '../../src/main/features/library/engine'
import { extractText, hashFile, type ExtractAssets } from '../../src/main/features/library/extract'
import { scanFolder } from '../../src/main/features/library/scanner'

/** pdf.js CMaps / standard fonts from node_modules (the app serves the same files from out/renderer/pdfjs). */
export const TEST_ASSETS: ExtractAssets = {
  cMapUrl: resolve('node_modules/pdfjs-dist/cmaps') + '/',
  standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/'
}

/** In-process engine: the same scanner/extractor the worker thread runs, called directly (no threads in unit tests). */
export class DirectEngine implements IndexEngine {
  scans = 0
  extracts = 0
  hashes = 0
  extractedPaths: string[] = []

  async scan(root: string, options: { maxDepth: number; maxFiles: number }, onProgress: (n: number) => void, signal: AbortSignal) {
    this.scans++
    return scanFolder(root, { ...options, signal, onProgress: (n) => onProgress(n), readAttributes: async () => new Map() })
  }
  async extract(request: Parameters<IndexEngine['extract']>[0], signal: AbortSignal) {
    if (signal.aborted) throw new Error('Cancelled')
    this.extracts++
    this.extractedPaths.push(request.path)
    return extractText(request)
  }
  async hash(path: string) {
    this.hashes++
    return hashFile(path)
  }
  async close(): Promise<void> {}
}
