/**
 * Turns scanner error codes (WIA HRESULTs, helper codes) into messages a person can act on. No jargon, one next step.
 */

export type ScanErrorCode =
  | 'paper_jam'
  | 'no_paper'
  | 'paper_problem'
  | 'offline'
  | 'busy'
  | 'warming_up'
  | 'user_intervention'
  | 'cover_open'
  | 'lamp_off'
  | 'locked'
  | 'communication'
  | 'not_found'
  | 'unavailable'
  | 'timeout'
  | 'unsupported'
  | 'general'

export const SCAN_ERROR_TEXT: Record<ScanErrorCode, string> = {
  paper_jam: 'The scanner reports a paper jam. Clear the paper path, then try again.',
  no_paper: 'There is no paper in the document feeder. Load the pages (or switch to the flatbed) and try again.',
  paper_problem: 'The scanner could not feed the paper. Straighten the pages, check the feeder, and try again.',
  offline: 'The scanner is offline or switched off. Turn it on, check the cable or network connection, and try again.',
  busy: 'The scanner is busy with another job. Wait for it to finish (or close other scanning programs) and try again.',
  warming_up: 'The scanner is still warming up. Wait a moment and try again.',
  user_intervention: 'The scanner needs attention. Check its display or its own utility, then try again.',
  cover_open: 'The scanner cover is open. Close it and try again.',
  lamp_off: 'The scanner lamp is off. Check that the scanner is powered on and try again.',
  locked: 'The scanner is in use by another program. Close other scanning software and try again.',
  communication: 'Epdf could not communicate with the scanner. Check the cable or network connection and try again.',
  not_found: 'The scanner was not found. Make sure it is on and connected, then refresh the scanner list.',
  unavailable: 'Scanning from a device is not available on this computer.',
  timeout: 'The scanner did not respond in time. Check that it is on and connected, then try again.',
  unsupported: 'The scanner returned a picture format Epdf cannot read.',
  general: 'The scanner reported an error.'
}

/** WIA_ERROR_* / WIA_S_* HRESULTs (winerror.h, facility 0x0021). */
const WIA_HRESULTS: Record<string, ScanErrorCode> = {
  '0x80210001': 'general',
  '0x80210002': 'paper_jam',
  '0x80210003': 'no_paper',
  '0x80210004': 'paper_problem',
  '0x80210005': 'offline',
  '0x80210006': 'busy',
  '0x80210007': 'warming_up',
  '0x80210008': 'user_intervention',
  '0x80210009': 'general',
  '0x8021000a': 'communication',
  '0x8021000b': 'general',
  '0x8021000c': 'general',
  '0x8021000d': 'locked',
  '0x8021000e': 'general',
  '0x8021000f': 'general',
  '0x80210015': 'not_found',
  '0x80210016': 'cover_open',
  '0x80210017': 'lamp_off'
}

export function codeFromHresult(hresult: string | undefined): ScanErrorCode | null {
  if (!hresult) return null
  return WIA_HRESULTS[hresult.toLowerCase()] ?? null
}

/** Finds a WIA HRESULT written into free text ("Exception from HRESULT: 0x80210003"). */
export function hresultInText(text: string): string | undefined {
  return /0x8021[0-9a-f]{4}/i.exec(text)?.[0]
}

export class ScanError extends Error {
  constructor(
    readonly code: ScanErrorCode,
    message?: string
  ) {
    super(message ?? SCAN_ERROR_TEXT[code])
    this.name = 'ScanError'
  }
}

/** Builds the error for an `error` protocol message. */
export function errorFromMessage(m: { code?: string; hresult?: string; message?: string }): ScanError {
  const fromHresult = codeFromHresult(m.hresult ?? (m.message ? hresultInText(m.message) : undefined))
  const known = (m.code && m.code in SCAN_ERROR_TEXT ? (m.code as ScanErrorCode) : null) ?? fromHresult
  if (known && known !== 'general') return new ScanError(known)
  const detail = (m.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
  return new ScanError('general', detail ? `${SCAN_ERROR_TEXT.general} (${detail})` : SCAN_ERROR_TEXT.general)
}
