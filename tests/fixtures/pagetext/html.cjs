// HTML documents for the page text fixtures: the same corpus is printed by LibreOffice (HTML import) and Chromium.
// `spans: true` wraps every word in <span class="w" data-line=".." data-k=".."> so Chromium can report its box
// (independent ground truth for highlight geometry). LibreOffice gets plain paragraphs, like ordinary documents.
const corpus = require('./corpus.json')

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function words(id, text, spans) {
  if (!spans) return esc(text)
  return text
    .split(' ')
    .map((w, k) => `<span class="w" data-line="${id}" data-k="${k}">${esc(w)}</span>`)
    .join(' ')
}

function page(body, chromium) {
  const css = chromium
    ? '@page { size: A4; margin: 0 } html, body { margin: 0 } body { padding: 40px; width: 690px }'
    : ''
  return `<!doctype html><html><head><meta charset="utf-8"><title>pagetext</title><style>${css} p { margin: 0 0 14pt 0 }</style></head><body>${body}</body></html>`
}

const para = (item, spans, size = 16) =>
  `<p dir="${item.dir}" style="text-align:${item.dir === 'rtl' ? 'right' : 'left'}; font-family:'${item.font}'; font-size:${size}pt">${words(item.id, item.text, spans)}</p>`

function lines(chromium) {
  return page(corpus.lines.map((l) => para(l, chromium)).join('\n'), chromium)
}

function paragraphs(chromium) {
  return page(corpus.paragraphs.map((p) => para(p, chromium, 20)).join('\n'), chromium)
}

function columns(chromium) {
  const c = corpus.columns
  const cell = (id, text) => `<td style="width:47%; vertical-align:top"><p dir="rtl" style="text-align:right; font-family:'${c.font}'; font-size:16pt">${words(id, text, chromium)}</p></td>`
  const body = `<table dir="rtl" style="width:100%; border-collapse:collapse"><tr>${cell('col-first', c.first)}<td style="width:6%"></td>${cell('col-second', c.second)}</tr></table>`
  return page(body, chromium)
}

/** Rotated text (Chromium only: CSS transforms print as rotated text). */
function rotated() {
  const l = corpus.lines.find((x) => x.id === 'ar-date')
  const h = corpus.lines.find((x) => x.id === 'ar-hello')
  const body =
    `<div style="position:absolute; left:120px; top:420px; transform:rotate(-90deg); transform-origin:0 0">${para(h, true)}</div>` +
    `<div style="position:absolute; left:220px; top:260px; transform:rotate(30deg); transform-origin:0 0; width:520px">${para(l, true)}</div>`
  return page(body, true)
}

/**
 * An independent check document (written by someone else, Arial, dir on <html>): dates, times, a currency amount in
 * brackets, an e-mail address, a phone number, a quotation with tashkeel and Arabic-Indic years.
 */
function fresh() {
  const lines = corpus.fresh.map((t) => `<p>${esc(t)}</p>`).join('\n')
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>t</title></head>
<body style="font-family: 'Arial'; font-size: 14pt">
${lines}
</body></html>
`
}

module.exports = { lines, paragraphs, columns, rotated, fresh }
