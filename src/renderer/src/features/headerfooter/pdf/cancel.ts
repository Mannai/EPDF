/** Thrown when the user cancels an apply/remove; nothing is committed (the edit callback throws). */
export class ApplyCancelled extends Error {
  constructor() {
    super('Cancelled.')
    this.name = 'ApplyCancelled'
  }
}
