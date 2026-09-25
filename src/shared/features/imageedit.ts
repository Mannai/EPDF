/** What the main process returns for `imageedit:pickImage` (null when the user cancels the dialog). */
export interface PickedImage {
  name: string
  kind: 'png' | 'jpg'
  bytes: Uint8Array
}
