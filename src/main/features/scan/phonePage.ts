/**
 * The page a phone loads from Epdf's temporary LAN server. Fully self-contained (inline CSS/JS guarded by a per-response
 * nonce, no external assets), so it works on a network with no internet. All text from the user's files is inserted with
 * textContent, never as HTML.
 */

export interface PhonePageOptions {
  nonce: string
  maxFileMb: number
  expiresInMinutes: number
}

export function renderPhonePage(o: PhonePageOptions): string {
  const nonce = o.nonce.replace(/[^A-Za-z0-9_-]/g, '')
  const maxMb = Math.max(1, Math.floor(o.maxFileMb))
  const mins = Math.max(1, Math.floor(o.expiresInMinutes))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Send pages to Epdf</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--bg:#ffffff;--ink:#1a1a1a;--muted:#555;--line:#c8c8c8;--accent:#0b5cad;--accent-ink:#fff;--warn:#fff4d6;--warn-ink:#5a3d00}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--ink:#f0f0f0;--muted:#b0b0b0;--line:#444;--accent:#6ab0ff;--accent-ink:#00213f;--warn:#3a2f10;--warn-ink:#ffe3a3}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:34rem;margin:0 auto;padding:1rem}
h1{font-size:1.4rem;margin:.5rem 0 1rem}
.warn{background:var(--warn);color:var(--warn-ink);border-radius:8px;padding:.75rem;font-size:.95rem}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin:1rem 0}
.btn{position:relative;display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 1.25rem;border-radius:10px;background:var(--accent);color:var(--accent-ink);font-weight:600;cursor:pointer;flex:1 1 10rem;text-align:center}
.btn.alt{background:transparent;color:var(--accent);border:2px solid var(--accent)}
.btn input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}
.btn:focus-within{outline:3px solid var(--ink);outline-offset:2px}
#status{color:var(--muted)}
ul{padding:0;list-style:none;border-top:1px solid var(--line)}
li{padding:.5rem 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
small{color:var(--muted)}
</style>
</head>
<body>
<main>
<h1>Send pages to Epdf</h1>
<p class="warn" role="note">This connection is not encrypted (plain HTTP on your local network). Anyone on this Wi-Fi could see the photos while they are sent. Use it only on a network you trust.</p>
<div class="actions">
<label class="btn">Take a photo<input id="cam" type="file" accept="image/*" capture="environment" aria-label="Take a photo"></label>
<label class="btn alt">Choose photos<input id="pick" type="file" accept="image/*" multiple aria-label="Choose photos from your gallery"></label>
</div>
<p id="status" role="status" aria-live="polite">Ready. Photos appear in Epdf as soon as they are sent.</p>
<ul id="list" aria-label="Sent photos"></ul>
<p><small>Photos up to ${maxMb} MB each. This link stops working when the dialog in Epdf is closed, or after about ${mins} minutes.</small></p>
</main>
<script nonce="${nonce}">
(function () {
  var base = location.pathname.replace(/\\/+$/, '') + '/upload';
  var maxBytes = ${maxMb} * 1024 * 1024;
  var status = document.getElementById('status');
  var list = document.getElementById('list');
  var queue = [];
  var busy = false;
  var sent = 0;
  function say(t) { status.textContent = t; }
  function add(name) {
    var li = document.createElement('li');
    li.textContent = name + ' - waiting';
    list.insertBefore(li, list.firstChild);
    return li;
  }
  function next() {
    if (busy || !queue.length) return;
    busy = true;
    var job = queue.shift();
    var label = job.file.name || 'photo';
    job.li.textContent = label + ' - sending...';
    if (job.file.size > maxBytes) {
      job.li.textContent = label + ' - too large (limit ${maxMb} MB)';
      busy = false;
      return next();
    }
    var fd = new FormData();
    fd.append('photo', job.file, 'photo');
    fetch(base, { method: 'POST', body: fd, headers: { 'X-Epdf-Upload': '1' }, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
      })
      .then(function (res) {
        if (res.ok && res.j.accepted) { sent += res.j.accepted; job.li.textContent = label + ' - sent'; say(sent + (sent === 1 ? ' photo' : ' photos') + ' sent.'); }
        else if (res.status === 410) { job.li.textContent = label + ' - link expired'; say('This link has expired. Ask Epdf for a new QR code.'); }
        else { job.li.textContent = label + ' - not accepted' + (res.j && res.j.error ? ': ' + res.j.error : ''); say('Some photos were not accepted.'); }
      })
      .catch(function () { job.li.textContent = label + ' - failed (connection lost, or the link closed)'; say('Could not reach Epdf. Is the dialog still open?'); })
      .then(function () { busy = false; next(); });
  }
  function take(input) {
    Array.prototype.forEach.call(input.files, function (f) { queue.push({ file: f, li: add(f.name || 'photo') }); });
    input.value = '';
    next();
  }
  document.getElementById('cam').addEventListener('change', function (e) { take(e.target); });
  document.getElementById('pick').addEventListener('change', function (e) { take(e.target); });
})();
</script>
</body>
</html>
`
}
