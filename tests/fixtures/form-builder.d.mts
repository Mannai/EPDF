export interface ExpectedField {
  kind: string
  /** [x0, y0, x1, y1] in the page as the reader sees it (origin bottom-left, y up). */
  box: [number, number, number, number]
  label?: string
  header?: string
  multiline?: boolean
  cells?: number
  options?: string[]
}
export interface FlatFixture {
  bytes: Uint8Array
  expected: ExpectedField[]
}
type Make = (rotate?: number) => Promise<FlatFixture>
export const createUnderlines: Make
export const createBoxes: Make
export const createChoices: Make
export const createCombs: Make
export const createTables: Make
export const createColumns: Make
export const createLeaders: Make
export const createNegatives: Make
export const createMixed: Make
export function createScan(): Promise<{ bytes: Uint8Array }>
export function createScanWithOcrLayer(): Promise<{ bytes: Uint8Array }>
export function createFieldsForm(): Promise<{ bytes: Uint8Array }>
