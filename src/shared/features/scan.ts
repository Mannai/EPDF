import { z } from 'zod'

/** Types and payload schemas shared by the scan feature's main and renderer halves. */

export const SCAN_SESSION_ID = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)

export type ScanBackendId = 'wia' | 'mac' | 'stub' | 'none'
export type ColorMode = 'color' | 'gray' | 'bw'
export type PaperSource = 'flatbed' | 'feeder'

export interface ScannerDevice {
  id: string
  name: string
  manufacturer?: string
}

export interface ScannerCaps {
  resolutions: number[]
  colorModes: ColorMode[]
  sources: PaperSource[]
  duplex: boolean
}

export interface ScanEnvironment {
  backend: ScanBackendId
  platform: 'win32' | 'darwin' | 'linux'
  /** Why scanning from a device is unavailable (clear, user-presentable), when backend is `none`. */
  message?: string
  /** True when the test scanner (EPDF_SCANNER_STUB) is active. */
  stub: boolean
}

export const ColorModeSchema = z.enum(['color', 'gray', 'bw'])
export const PaperSourceSchema = z.enum(['flatbed', 'feeder'])

export const ScanDevicesRequestSchema = z.object({})
export const ScanCapsRequestSchema = z.object({ deviceId: z.string().min(1).max(600) })

export const ScanAcquireSchema = z.object({
  sessionId: SCAN_SESSION_ID,
  deviceId: z.string().min(1).max(600),
  dpi: z.number().int().min(50).max(1200),
  colorMode: ColorModeSchema,
  source: PaperSourceSchema,
  duplex: z.boolean(),
  maxPages: z.number().int().min(1).max(500)
})
export type ScanAcquireRequest = z.infer<typeof ScanAcquireSchema>

export const ScanSessionRequestSchema = z.object({ sessionId: SCAN_SESSION_ID })
export const PhoneStartSchema = z.object({ sessionId: SCAN_SESSION_ID })
export const PhoneStopSchema = z.object({ sessionId: SCAN_SESSION_ID })

export const ScanSaveSchema = z.object({
  bytes: z.custom<Uint8Array>((v) => v instanceof Uint8Array && v.length > 0 && v.length <= 1024 * 1024 * 1024, 'Expected PDF bytes'),
  suggestedName: z.string().max(200).default('Scan.pdf')
})

/** Events main pushes to the renderer (all carry the session id so windows never see each other's pages). */
export interface ScanPageEvent {
  sessionId: string
  index: number
  mime: 'image/png' | 'image/jpeg' | 'image/bmp' | 'image/webp'
  dpi: number
  bytes: Uint8Array
}

export interface PhoneImageEvent {
  sessionId: string
  id: string
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  bytes: Uint8Array
}

export interface PhoneEndpoint {
  address: string
  interfaceName: string
  url: string
  /** Interface looks virtual (WSL, Docker, VPN): phones usually cannot reach it. */
  likelyVirtual: boolean
}

export interface PhoneStartResult {
  endpoints: PhoneEndpoint[]
  /** Epoch ms after which the link stops working. */
  expiresAt: number
  maxFileMb: number
  /** Non-fatal problems, e.g. "some interfaces could not be opened". */
  warnings: string[]
}

export interface PhoneStatusEvent {
  sessionId: string
  state: 'expired' | 'closed'
}

export interface ScanSaveResult {
  path: string
  name: string
}

/** Test-only fixed values shared with the e2e spec. */
export const SCAN_LIMITS = {
  maxPhoneFileBytes: 25 * 1024 * 1024,
  phoneTtlMs: 10 * 60 * 1000
} as const
