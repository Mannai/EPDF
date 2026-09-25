import qrcode from 'qrcode-generator'

/** QR code module matrix for a URL (qrcode-generator, MIT). Error correction M; version chosen automatically. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  const rows: boolean[][] = []
  for (let r = 0; r < n; r++) {
    const row: boolean[] = []
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c))
    rows.push(row)
  }
  return rows
}

/** One SVG path (unit squares) for the dark modules; the viewBox includes the mandatory 4-module quiet zone. */
export function qrSvgPath(matrix: boolean[][], quiet = 4): { d: string; size: number } {
  const n = matrix.length
  let d = ''
  for (let r = 0; r < n; r++) {
    let c = 0
    while (c < n) {
      if (!matrix[r][c]) {
        c++
        continue
      }
      let end = c
      while (end < n && matrix[r][end]) end++
      d += `M${c + quiet} ${r + quiet}h${end - c}v1h${-(end - c)}z`
      c = end
    }
  }
  return { d, size: n + quiet * 2 }
}

/** Rasterises the matrix (black on white with the quiet zone) for verification / export. */
export function qrRaster(matrix: boolean[][], scale = 4, quiet = 4): { width: number; height: number; data: Uint8ClampedArray } {
  const size = (matrix.length + quiet * 2) * scale
  const data = new Uint8ClampedArray(size * size * 4).fill(255)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mr = Math.floor(y / scale) - quiet
      const mc = Math.floor(x / scale) - quiet
      if (mr >= 0 && mc >= 0 && mr < matrix.length && mc < matrix.length && matrix[mr][mc]) {
        const o = (y * size + x) * 4
        data[o] = data[o + 1] = data[o + 2] = 0
      }
    }
  }
  return { width: size, height: size, data }
}
