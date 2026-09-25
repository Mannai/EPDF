/**
 * Plain-data descriptions of the fields the builder creates and edits. Everything here is JSON-friendly so it
 * can live in stores, clipboards and undo labels. Rectangles are always in PDF user space (the unrotated
 * page, origin bottom-left) - the same space as a widget's /Rect. Pure TypeScript.
 */

export type BuilderKind = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list' | 'signature' | 'button'

export interface URect {
  x1: number
  y1: number
  x2: number
  y2: number
}

export type FontName = 'Helv' | 'HeBo' | 'TiRo' | 'TiBo' | 'Cour' | 'CoBo'

export const FONT_CHOICES: { name: FontName; label: string }[] = [
  { name: 'Helv', label: 'Helvetica' },
  { name: 'HeBo', label: 'Helvetica Bold' },
  { name: 'TiRo', label: 'Times' },
  { name: 'TiBo', label: 'Times Bold' },
  { name: 'Cour', label: 'Courier' },
  { name: 'CoBo', label: 'Courier Bold' }
]

export type Align = 'left' | 'center' | 'right'
export type BorderStyle = 'solid' | 'dashed' | 'beveled' | 'inset' | 'underline'

export interface FieldStyle {
  fontName: FontName
  /** Points; 0 = automatic. */
  fontSize: number
  /** `#rrggbb`. */
  textColor: string
  align: Align
  /** `#rrggbb`, or null for no border. */
  borderColor: string | null
  /** `#rrggbb`, or null for a transparent background. */
  backgroundColor: string | null
  borderWidth: number
  borderStyle: BorderStyle
}

export const DEFAULT_STYLE: FieldStyle = {
  fontName: 'Helv',
  fontSize: 0,
  textColor: '#000000',
  align: 'left',
  borderColor: '#000000',
  backgroundColor: '#ffffff',
  borderWidth: 1,
  borderStyle: 'solid'
}

/** Look of a field laid over an existing printed box or rule: it must not draw a second border. */
export const OVERLAY_STYLE: Partial<FieldStyle> = { borderColor: null, backgroundColor: null, borderWidth: 0 }

// ---- validation / formatting (stored as Acrobat-compatible /AA JavaScript actions) --------------------------------

export type SpecialFormat = 'zip' | 'zip4' | 'phone' | 'ssn'

export type FormatSpec =
  | { type: 'none' }
  /** sep: 0 = 1,234.56  1 = 1234.56  2 = 1.234,56  3 = 1234,56 ; neg: 0 = -x  1 = red -x  2 = (x)  3 = red (x). */
  | { type: 'number'; decimals: number; sep: 0 | 1 | 2 | 3; neg: 0 | 1 | 2 | 3; currency: string; prepend: boolean; min?: number; max?: number }
  | { type: 'percent'; decimals: number; sep: 0 | 1 | 2 | 3 }
  | { type: 'date'; format: string }
  | { type: 'time'; format: 0 | 1 | 2 | 3 }
  | { type: 'special'; special: SpecialFormat }
  | { type: 'email' }
  | { type: 'regex'; pattern: string; message: string }

export const NO_FORMAT: FormatSpec = { type: 'none' }

export const DATE_FORMATS = ['dd/mm/yyyy', 'mm/dd/yyyy', 'yyyy-mm-dd', 'd mmmm yyyy', 'dd.mm.yyyy', 'mm/dd/yy', 'dd/mm/yy']

// ---- what to create -----------------------------------------------------------------------------------------------

export interface RadioButtonSpec {
  rect: URect
  value: string
}

export interface FieldSpec {
  kind: BuilderKind
  name: string
  pageIndex: number
  /** The widget's rectangle; radio groups use `buttons` instead (this is then their bounding box). */
  rect: URect
  tooltip?: string
  required?: boolean
  readOnly?: boolean
  hidden?: boolean
  /** Text/dropdown: initial value; checkbox: 'true' checks it; radio: the selected export value. */
  value?: string
  maxLength?: number
  multiline?: boolean
  password?: boolean
  comb?: boolean
  /** Dropdown / list options; text for the choices. */
  options?: string[]
  editable?: boolean
  multiSelect?: boolean
  /** Checkbox: export value written for the checked state (default `Yes`). */
  onValue?: string
  /** Push button caption. */
  caption?: string
  buttons?: RadioButtonSpec[]
  style?: Partial<FieldStyle>
  format?: FormatSpec
}

export const KIND_LABEL: Record<BuilderKind, string> = {
  text: 'Text field',
  checkbox: 'Check box',
  radio: 'Radio group',
  dropdown: 'Dropdown',
  list: 'List box',
  signature: 'Signature field',
  button: 'Button'
}

export const DEFAULT_SIZE: Record<BuilderKind, { w: number; h: number }> = {
  text: { w: 160, h: 22 },
  checkbox: { w: 14, h: 14 },
  radio: { w: 14, h: 14 },
  dropdown: { w: 140, h: 22 },
  list: { w: 140, h: 64 },
  signature: { w: 200, h: 44 },
  button: { w: 90, h: 26 }
}

export const NAME_STEM: Record<BuilderKind, string> = {
  text: 'Text',
  checkbox: 'Check_Box',
  radio: 'Radio_Group',
  dropdown: 'Dropdown',
  list: 'List_Box',
  signature: 'Signature',
  button: 'Button'
}

// ---- what a field looks like once read back ---------------------------------------------------------------------

export interface WidgetInfo {
  index: number
  pageIndex: number
  rect: URect
  /** Page /Rotate at the time of reading. */
  pageRotation: number
  /** Radio buttons: the export value; checkboxes: the on-state name. */
  value?: string
  hidden: boolean
}

export interface FieldInfo {
  name: string
  /** The part of the name before the last period (empty for flat names). */
  namePrefix: string
  kind: BuilderKind
  tooltip: string
  required: boolean
  readOnly: boolean
  hidden: boolean
  /** Text: the value; checkbox: 'true' / ''; radio/dropdown: the selection; list: joined with a newline. */
  value: string
  defaultValue: string
  maxLength?: number
  multiline: boolean
  password: boolean
  comb: boolean
  options: string[]
  editable: boolean
  multiSelect: boolean
  onValue: string
  caption: string
  style: FieldStyle
  format: FormatSpec
  widgets: WidgetInfo[]
}

/** Edits that can be applied to an existing field (the properties panel produces these). */
export type FieldPatch = Partial<
  Pick<FieldInfo, 'tooltip' | 'required' | 'readOnly' | 'hidden' | 'value' | 'defaultValue' | 'maxLength' | 'multiline' | 'password' | 'comb' | 'options' | 'editable' | 'multiSelect' | 'onValue' | 'caption'>
> & {
  name?: string
  style?: Partial<FieldStyle>
  format?: FormatSpec
  /** Radio: new export values, one per widget in order. */
  radioValues?: string[]
}

export const rectWidth = (r: URect): number => Math.abs(r.x2 - r.x1)
export const rectHeight = (r: URect): number => Math.abs(r.y2 - r.y1)
export const normRect = (r: URect): URect => ({ x1: Math.min(r.x1, r.x2), y1: Math.min(r.y1, r.y2), x2: Math.max(r.x1, r.x2), y2: Math.max(r.y1, r.y2) })
