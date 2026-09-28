import type { Color } from './basics'

/**
 * Built-in stamps, drawn programmatically as vector appearance streams (no images). `name` is written
 * to /Name; the standard PDF stamp names are used where one exists.
 */
export interface StampDef {
  name: string
  label: string
  color: Color
  /** `box` = rounded rectangle outline; `arrow` = filled flag pointing right (Sign Here). */
  shape: 'box' | 'arrow'
  /** Text on a second, smaller line (optional). */
  sub?: string
  /** Arabic stamps: the word is drawn by the text engine (shaped, right to left). */
  lang?: 'ar'
}

const RED: Color = [0.75, 0.1, 0.1]
const GREEN: Color = [0.1, 0.5, 0.2]
const BLUE: Color = [0.1, 0.25, 0.7]
const GRAY: Color = [0.3, 0.33, 0.38]
const ORANGE: Color = [0.75, 0.4, 0.0]

export const STAMPS: readonly StampDef[] = [
  { name: 'Approved', label: 'APPROVED', color: GREEN, shape: 'box' },
  { name: 'NotApproved', label: 'NOT APPROVED', color: RED, shape: 'box' },
  { name: 'Draft', label: 'DRAFT', color: GRAY, shape: 'box' },
  { name: 'Confidential', label: 'CONFIDENTIAL', color: RED, shape: 'box' },
  { name: 'Final', label: 'FINAL', color: BLUE, shape: 'box' },
  { name: 'ForComment', label: 'FOR COMMENT', color: BLUE, shape: 'box' },
  { name: 'Reviewed', label: 'REVIEWED', color: BLUE, shape: 'box' },
  { name: 'Rejected', label: 'REJECTED', color: RED, shape: 'box' },
  { name: 'Completed', label: 'COMPLETED', color: GREEN, shape: 'box' },
  { name: 'Void', label: 'VOID', color: RED, shape: 'box' },
  { name: 'Received', label: 'RECEIVED', color: ORANGE, shape: 'box' },
  { name: 'SignHere', label: 'SIGN HERE', color: [0.15, 0.15, 0.2], shape: 'arrow' },
  // Arabic set (/Name EpdfAr…: not standard names, so no other reader substitutes its own English icon).
  { name: 'EpdfArApproved', label: 'معتمد', color: GREEN, shape: 'box', lang: 'ar' },
  { name: 'EpdfArNotApproved', label: 'غير معتمد', color: RED, shape: 'box', lang: 'ar' },
  { name: 'EpdfArDraft', label: 'مسودة', color: GRAY, shape: 'box', lang: 'ar' },
  { name: 'EpdfArConfidential', label: 'سري', color: RED, shape: 'box', lang: 'ar' },
  { name: 'EpdfArFinal', label: 'نهائي', color: BLUE, shape: 'box', lang: 'ar' },
  { name: 'EpdfArForComment', label: 'للتعليق', color: BLUE, shape: 'box', lang: 'ar' },
  { name: 'EpdfArReviewed', label: 'تمت المراجعة', color: BLUE, shape: 'box', lang: 'ar' },
  { name: 'EpdfArRejected', label: 'مرفوض', color: RED, shape: 'box', lang: 'ar' },
  { name: 'EpdfArCompleted', label: 'مكتمل', color: GREEN, shape: 'box', lang: 'ar' },
  { name: 'EpdfArVoid', label: 'ملغى', color: RED, shape: 'box', lang: 'ar' },
  { name: 'EpdfArReceived', label: 'تم الاستلام', color: ORANGE, shape: 'box', lang: 'ar' },
  { name: 'EpdfArSignHere', label: 'وقّع هنا', color: [0.15, 0.15, 0.2], shape: 'arrow', lang: 'ar' }
]

export const stampByName = (name: string | undefined): StampDef | undefined => STAMPS.find((s) => s.name === name)

/** Human label for /Name (falls back to splitting camel case: "NotForPublicRelease" → "Not For Public Release"). */
export function stampLabel(name: string | undefined): string {
  const def = stampByName(name)
  if (def?.lang) return def.label
  if (def) return def.label.toLowerCase().replace(/(^| )(\w)/g, (_m, a: string, b: string) => a + b.toUpperCase())
  return (name ?? 'Stamp').replace(/([a-z])([A-Z])/g, '$1 $2')
}
