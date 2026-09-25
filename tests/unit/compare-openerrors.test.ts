import { describe, expect, it } from 'vitest'
import { describeOpenError, isPasswordError } from '../../src/renderer/src/features/compare/openErrors'

class PasswordCancelledError extends Error {
  constructor() {
    super('A password is required to open this document.')
  }
}

describe('messages for inputs that cannot be opened', () => {
  it('a declined or missing password names the file and says what to do', () => {
    for (const err of [new PasswordCancelledError(), Object.assign(new Error('No password given'), { name: 'PasswordException' })]) {
      expect(isPasswordError(err)).toBe(true)
      const m = describeOpenError(err, 'secret.pdf')
      expect(m).toContain('“secret.pdf” is password protected')
      expect(m).toContain('enter its password')
    }
  })

  it('a file that is not a PDF or is damaged says so', () => {
    for (const err of [Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' }), Object.assign(new Error('x'), { name: 'FormatError' }), new Error('Missing PDF "x"'), new Error('Bad XRef entry')]) {
      expect(isPasswordError(err)).toBe(false)
      expect(describeOpenError(err, 'a.pdf')).toBe('“a.pdf” could not be read: it is damaged or is not a PDF file.')
    }
  })

  it('anything else is reported with its own message, never as a stack trace or "undefined"', () => {
    expect(describeOpenError(new Error('Out of memory'), 'big.pdf')).toBe('“big.pdf” could not be opened: Out of memory')
    expect(describeOpenError('boom', 'x.pdf')).toBe('“x.pdf” could not be opened: boom')
    expect(describeOpenError(undefined, 'x.pdf')).toBe('“x.pdf” could not be opened: ')
    expect(isPasswordError(null)).toBe(false)
  })
})
