import { z } from 'zod'

/**
 * The line protocol every scanner helper speaks on stdout: one JSON object per line. Implemented by the Windows
 * WIA PowerShell script (./wia.ts), the macOS helper (resources/native/mac-scan) and the test helpers. Lines that
 * are not valid protocol messages (PowerShell warnings, library chatter) are collected as "noise" and ignored.
 */

const Id = z.string().min(1).max(600)

export const ProtocolMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('devices'),
    devices: z.array(z.object({ id: Id, name: z.string().max(200), manufacturer: z.string().max(200).optional() })).max(64)
  }),
  z.object({
    type: z.literal('caps'),
    resolutions: z.array(z.number().int().min(1).max(20000)).max(4000),
    colorModes: z.array(z.enum(['color', 'gray', 'bw'])).max(3),
    sources: z.array(z.enum(['flatbed', 'feeder'])).max(2),
    duplex: z.boolean()
  }),
  z.object({ type: z.literal('progress'), message: z.string().max(200), fraction: z.number().min(0).max(1).optional() }),
  z.object({ type: z.literal('page'), index: z.number().int().min(1).max(100000), file: z.string().min(1).max(1024), dpi: z.number().min(1).max(20000).optional() }),
  z.object({ type: z.literal('error'), code: z.string().max(64).optional(), hresult: z.string().max(16).optional(), message: z.string().max(2000).default('') }),
  z.object({ type: z.literal('done'), pages: z.number().int().min(0).max(100000).optional() })
])
export type ProtocolMessage = z.infer<typeof ProtocolMessageSchema>

const MAX_LINE = 1024 * 1024

/** Incremental line splitter + validator for helper stdout. */
export class LineParser {
  private buf = ''
  private discarding = false
  readonly noise: string[] = []

  push(chunk: string): ProtocolMessage[] {
    this.buf += chunk
    const out: ProtocolMessage[] = []
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (this.discarding) {
        this.discarding = false
        continue
      }
      this.handle(line, out)
    }
    if (this.buf.length > MAX_LINE) {
      // A runaway line: drop it (and its tail) instead of growing without bound.
      this.buf = ''
      this.discarding = true
      this.noise.push('(overlong output line dropped)')
    }
    return out
  }

  /** Flush a final line that had no trailing newline. */
  end(): ProtocolMessage[] {
    const out: ProtocolMessage[] = []
    if (this.buf.length && !this.discarding) this.handle(this.buf, out)
    this.buf = ''
    return out
  }

  private handle(raw: string, out: ProtocolMessage[]): void {
    const line = raw.replace(/^﻿/, '').trim()
    if (!line) return
    if (line[0] !== '{') return void this.remember(line)
    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {
      return void this.remember(line)
    }
    const parsed = ProtocolMessageSchema.safeParse(json)
    if (parsed.success) out.push(parsed.data)
    else this.remember(line)
  }

  private remember(line: string): void {
    if (this.noise.length < 20) this.noise.push(line.slice(0, 300))
  }
}
