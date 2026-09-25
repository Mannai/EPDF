import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { convertOffice } from '../../src/main/features/create/office'
import { buildDocx, para, tbl, tc, tr } from '../support/docxBuilder'
import { buildOds, tcell, trow } from '../support/odsBuilder'
import { buildOdp, frame as odpFrame, para as odpPara } from '../support/odpBuilder'
import { odtPackage, p as odtP } from '../support/odt'
import { buildPptx, textBox } from '../support/pptxBuilder'
import { buildXlsx, simpleRow, worksheet } from '../support/xlsxBuilder'

/**
 * Damaged, truncated and mutated documents must never hang or crash the converter: every input either converts or
 * fails with an Error whose message is presentable. Mutations are deterministic (seeded).
 */

const fontsDir = resolve('resources/fonts')

const fixtures: Record<string, Uint8Array> = {
  'a.docx': buildDocx({ body: para('Heading', { style: 'Heading1' }) + para('Body text here.') + tbl([tr([tc(para('a'), { w: 3000 }), tc(para('b'), { w: 3000 })])], [3000, 3000], { style: 'TableGrid' }) }),
  'a.xlsx': buildXlsx({ sheets: [{ name: 'S', xml: worksheet({ rows: simpleRow(1, ['x', 'y']) + simpleRow(2, [1, 2.5]) }) }] }),
  'a.pptx': buildPptx({ slides: [{ shapes: textBox(2, 914400, 914400, 4572000, 914400, ['Slide text']) }] }),
  'a.odt': odtPackage({ body: odtP('ODT text') }),
  'a.ods': buildOds({ tables: [{ name: 'T', xml: trow(tcell('a') + tcell(1)) }] }),
  'a.odp': buildOdp({ slides: [{ body: odpFrame(2, 3, 10, 2, odpPara('ODP text')) }] }),
  'a.rtf': strToU8('{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0\\fs24 Hello \\b bold\\b0 world\\par {\\trowd\\cellx3000\\cellx6000\\intbl A\\cell B\\cell\\row}}'),
  'a.csv': strToU8('a,b\n1,2\n"quoted, comma",3\n'),
  'a.txt': strToU8('plain\ntext\n')
}

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000)
}

/** Corrupts text parts INSIDE a zip package (the zip itself stays valid, so the readers' XML handling is exercised). */
function mutateZip(bytes: Uint8Array, rand: () => number): Uint8Array {
  const files = unzipSync(bytes)
  const names = Object.keys(files).filter((n) => /\.(xml|rels)$/.test(n))
  const out: Record<string, Uint8Array> = { ...files }
  for (let k = 0; k < 3; k++) {
    const name = names[Math.floor(rand() * names.length)]
    let text = strFromU8(files[name])
    const op = Math.floor(rand() * 4)
    const at = Math.floor(rand() * text.length)
    if (op === 0) text = text.slice(0, at) // truncate
    else if (op === 1) text = text.slice(0, at) + text.slice(at + 1 + Math.floor(rand() * 40)) // delete a span
    else if (op === 2) text = text.slice(0, at) + '<' + text.slice(at) // stray bracket
    else text = text.replace(/(\w+)="[^"]*"/, '$1="-99999999999"') // absurd numeric attribute
    out[name] = strToU8(text)
  }
  return zipSync(out)
}

const bytesOfString = (s: string): Uint8Array => strToU8(s)

describe('damaged input never hangs or crashes the built-in converter', () => {
  for (const [name, bytes] of Object.entries(fixtures)) {
    it(`${name}: truncated / mutated / garbage inputs end in a result or a presentable error`, async () => {
      const rand = rng(name.length * 7919)
      const variants: Uint8Array[] = [bytes.slice(0, Math.floor(bytes.length / 2)), bytes.slice(0, 10), new Uint8Array(0), bytesOfString('garbage garbage'), new Uint8Array(2000).fill(0x7b)]
      if (/\.(docx|xlsx|pptx|odt|ods|odp)$/.test(name)) for (let i = 0; i < 12; i++) variants.push(mutateZip(bytes, rand))
      for (const v of variants) {
        const t0 = Date.now()
        try {
          const r = await convertOffice({ name, bytes: v }, { fontsDir })
          expect(r.bytes.length).toBeGreaterThan(100)
        } catch (err) {
          expect(err).toBeInstanceOf(Error)
          expect((err as Error).message.length).toBeGreaterThan(5)
          expect((err as Error).message).not.toMatch(/undefined|\[object/)
        }
        expect(Date.now() - t0).toBeLessThan(10_000)
      }
    }, 120_000)
  }

  it('deeply nested RTF groups and huge repeat counts do not blow the stack or the clock', async () => {
    const deep = '{\\rtf1' + '{'.repeat(50_000) + 'deep text' + '}'.repeat(50_000) + '}'
    const t0 = Date.now()
    await convertOffice({ name: 'deep.rtf', bytes: strToU8(deep) }, { fontsDir }).catch(() => undefined)
    expect(Date.now() - t0).toBeLessThan(10_000)
    const bomb = buildOds({ tables: [{ name: 'T', xml: '<table:table-row table:number-rows-repeated="1000000000">' + tcell('x', undefined, 'table:number-columns-repeated="1000000000"') + '</table:table-row>' }] })
    const t1 = Date.now()
    await convertOffice({ name: 'bomb.ods', bytes: bomb }, { fontsDir }).catch(() => undefined)
    // capped (512 columns x 2000 rows of content) rather than a billion cells; the worst case is slow but bounded
    expect(Date.now() - t1).toBeLessThan(45_000)
  }, 120_000)
})
