// A stand-in for the macOS scanner helper (and any other helper that speaks Epdf's scan line protocol).
// Usage (like the real helper): node scan-stub-helper.mjs <list|caps|scan>, parameters as JSON in EPDF_SCAN_PARAMS.
// Behaviour switches for tests: STUB_MODE = normal | jam | slow | garbage | crash | nodone | escape | bigline | hang
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const params = JSON.parse(process.env.EPDF_SCAN_PARAMS ?? '{}')
const mode = process.env.STUB_MODE ?? 'normal'
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (b) => {
  let c = 0xffffffff
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const png = (w, h, shade) => {
  const raw = Buffer.alloc((w * 3 + 1) * h, shade)
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const command = process.argv[2]

if (mode === 'crash') {
  process.stderr.write('segmentation fault (simulated)\n')
  process.exit(139)
}
if (mode === 'hang') setInterval(() => undefined, 1000)
else if (mode === 'garbage') {
  process.stdout.write('WARNING: something noisy\n')
  process.stdout.write('{not json}\n')
  process.stdout.write('{"type":"mystery"}\n')
  send({ type: 'devices', devices: [{ id: 'mac-1', name: 'Stub Scanner', manufacturer: 'Epdf' }] })
  send({ type: 'done' })
} else if (mode === 'bigline') {
  process.stdout.write('x'.repeat(3 * 1024 * 1024) + '\n')
  send({ type: 'devices', devices: [] })
  send({ type: 'done' })
} else if (command === 'list') {
  send({ type: 'devices', devices: [{ id: 'mac-1', name: 'Stub Scanner', manufacturer: 'Epdf' }, { id: 'mac-2', name: 'Second Scanner' }] })
  send({ type: 'done' })
} else if (command === 'caps') {
  if (params.deviceId !== 'mac-1') {
    send({ type: 'error', code: 'not_found', message: 'no such device' })
    process.exit(2)
  }
  send({ type: 'caps', resolutions: [75, 150, 300, 600], colorModes: ['color', 'gray'], sources: ['flatbed', 'feeder'], duplex: false })
  send({ type: 'done' })
} else if (command === 'scan') {
  if (mode === 'jam') {
    send({ type: 'progress', message: 'Scanning page 1' })
    send({ type: 'error', hresult: '0x80210002', message: 'Exception from HRESULT: 0x80210002' })
    process.exit(2)
  }
  const total = params.source === 'feeder' ? Math.min(3, params.maxPages) : 1
  for (let i = 1; i <= total; i++) {
    send({ type: 'progress', message: `Scanning page ${i}` })
    if (mode === 'slow') await new Promise((r) => setTimeout(r, 400))
    const file = mode === 'escape' ? join(process.env.SystemRoot ?? '/etc', 'hosts') : join(params.dir, `page${String(i).padStart(3, '0')}.png`)
    if (mode !== 'escape') writeFileSync(file, png(24, 32, 40 * i))
    send({ type: 'page', index: i, file, dpi: params.dpi })
  }
  if (mode !== 'nodone') send({ type: 'done', pages: total })
}
