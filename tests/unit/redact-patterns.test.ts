import { describe, expect, it } from 'vitest'
import { PRESETS, dateValid, findPreset, ibanValid, luhn, presetById } from '../../src/renderer/src/features/redact/logic/patterns'

const found = (id: string, text: string): string[] => findPreset(text, presetById(id)!).map((r) => text.slice(r.start, r.end))

describe('checksums', () => {
  it('Luhn', () => {
    for (const ok of ['4111111111111111', '5500000000000004', '378282246310005', '6011111111111117', '30569309025904', '3530111333300000', '79927398713']) expect(luhn(ok), ok).toBe(true)
    for (const bad of ['4111111111111112', '1234567812345678', '0', '', '4111a11111111111', '79927398710']) expect(luhn(bad), bad).toBe(false)
  })

  it('IBAN: country length and mod 97', () => {
    for (const ok of ['DE89 3704 0044 0532 0130 00', 'GB82 WEST 1234 5698 7654 32', 'FR14 2004 1010 0505 0001 3M02 606', 'NL91ABNA0417164300', 'NO9386011117947', 'ES9121000418450200051332', 'CH9300762011623852957', 'BE68539007547034']) expect(ibanValid(ok), ok).toBe(true)
    for (const bad of ['DE89 3704 0044 0532 0130 01', 'DE00 1234', 'GB82WEST1234569876543', 'XX0000000000000000', 'DE8937040044053201300', '1234567890']) expect(ibanValid(bad), bad).toBe(false)
  })

  it('dates are real dates', () => {
    for (const ok of ['2024-03-15', '2024-02-29', '15/03/2024', '03/15/2024', '15.03.24', 'March 15, 2024', '15th March 2024', '1 Jan 2000', 'Sept. 3, 1999']) expect(dateValid(ok), ok).toBe(true)
    for (const bad of ['2023-02-29', '31/02/2024', '2024-13-01', '2024-00-10', '32/01/2024', 'Foo 3, 2000', 'March 32, 2024', '00/00/2000']) expect(dateValid(bad), bad).toBe(false)
  })
})

describe('built-in patterns', () => {
  it('e-mail addresses', () => {
    expect(found('email', 'Write to jane.doe+tag@example.co.uk, or bob_1@sub.domain.org.')).toEqual(['jane.doe+tag@example.co.uk', 'bob_1@sub.domain.org'])
    expect(found('email', 'not@valid, @nothing.com, plain text, user@localhost, a@b.c')).toEqual([])
  })

  it('phone numbers: US and international formats, not dates or other numbers', () => {
    expect(found('phone', 'Call (555) 123-4567, 555-123-4567, 555.123.4567, +1 555-123-4567 or 5551234567.')).toEqual(['(555) 123-4567', '555-123-4567', '555.123.4567', '+1 555-123-4567', '5551234567'])
    expect(found('phone', 'Abroad: +44 20 7946 0958 and +49 30 901820 and +81 3-1234-5678')).toEqual(['+44 20 7946 0958', '+49 30 901820', '+81 3-1234-5678'])
    expect(found('phone', 'Date 2024-03-15, year 2024, price 1234, zip 90210, version 1.2.3')).toEqual([])
    expect(found('phone', 'Serial 12345678901234567890')).toEqual([])
  })

  it('payment cards need a valid Luhn checksum', () => {
    expect(found('card', 'Cards: 4111 1111 1111 1111 and 5500-0000-0000-0004 and 378282246310005.')).toEqual(['4111 1111 1111 1111', '5500-0000-0000-0004', '378282246310005'])
    expect(found('card', 'Bad: 4111 1111 1111 1112, short 411111111111, order 1234567890123456.')).toEqual([])
    expect(found('card', 'Not part of a longer number: 94111111111111119')).toEqual([])
  })

  it('US Social Security numbers', () => {
    expect(found('ssn', 'SSN 123-45-6789 and 078 05 1120.')).toEqual(['123-45-6789', '078 05 1120'])
    expect(found('ssn', 'invalid 000-12-3456, 666-12-3456, 900-12-3456, 123-00-6789, 123-45-0000, 1234-56-7890')).toEqual([])
  })

  it('national ID numbers (checksummed)', () => {
    expect(found('national-id', 'UK AB 12 34 56 C.')).toEqual(['AB 12 34 56 C'])
    expect(found('national-id', 'Canada 046 454 286.')).toEqual(['046 454 286'])
    expect(found('national-id', 'Spain 12345678Z and X1234567L.')).toEqual(['12345678Z', 'X1234567L'])
    expect(found('national-id', 'France 1 84 12 76 451 089 46.')).toEqual(['1 84 12 76 451 089 46'])
    expect(found('national-id', 'wrong: 12345678A, 046 454 287, BG 12 34 56 C')).toEqual([])
  })

  it('IBANs', () => {
    expect(found('iban', 'Pay DE89 3704 0044 0532 0130 00 or GB82WEST12345698765432 now.')).toEqual(['DE89 3704 0044 0532 0130 00', 'GB82WEST12345698765432'])
    expect(found('iban', 'DE89 3704 0044 0532 0130 01 and DE00 1234')).toEqual([])
  })

  it('dates in several notations', () => {
    expect(found('date', 'On 2024-03-15, 15/03/2024, March 15, 2024 and 15th March 2024.')).toEqual(['2024-03-15', '15/03/2024', 'March 15, 2024', '15th March 2024'])
    expect(found('date', 'Not dates: 31/02/2024, 2024-13-45, v1/2/3, 1234-56-78')).toEqual([])
  })

  it('URLs (trailing punctuation is not part of them)', () => {
    expect(found('url', 'See https://example.com/path?q=1&r=2, or www.example.org. Also (https://a.b/c).')).toEqual(['https://example.com/path?q=1&r=2', 'www.example.org', 'https://a.b/c'])
    expect(found('url', 'no links here, example.com alone')).toEqual([])
  })

  it('IP addresses (IPv4 and IPv6)', () => {
    expect(found('ip', 'Hosts 192.168.0.1, 10.0.0.255 and 2001:db8::ff00:42:8329, 2001:0db8:0000:0000:0000:ff00:0042:8329.')).toEqual(['192.168.0.1', '10.0.0.255', '2001:db8::ff00:42:8329', '2001:0db8:0000:0000:0000:ff00:0042:8329'])
    expect(found('ip', 'Bad: 999.1.1.1, 256.1.1.1, 1.2.3, 1.2.3.4.5, version 1.2.3.4.5')).toEqual([])
  })

  it('every preset builds a fresh global regex, has examples that match and a description', () => {
    for (const p of PRESETS) {
      expect(p.build()).not.toBe(p.build())
      expect(p.build().global).toBe(true)
      expect(p.description.length).toBeGreaterThan(3)
      for (const ex of p.examples) expect(found(p.id, `text ${ex} text`), `${p.id}: ${ex}`).toContain(ex)
    }
  })

  it('no built-in pattern backtracks badly on hostile input', () => {
    const hostile = ['a'.repeat(20_000), '1'.repeat(20_000), ('1 ').repeat(10_000), 'http://' + 'a'.repeat(20_000), '@'.repeat(5000), '.'.repeat(20_000), ('1.').repeat(10_000), ':'.repeat(10_000), ('a-').repeat(10_000)]
    const started = Date.now()
    for (const p of PRESETS) for (const h of hostile) findPreset(h, p)
    expect(Date.now() - started).toBeLessThan(8000)
  })
})
