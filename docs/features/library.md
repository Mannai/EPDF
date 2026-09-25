# Local file library

File ▸ **Library…** (Ctrl/Cmd+Shift+L, or "Open Library" on the empty start page) opens a full-window layer for finding PDFs
across folders: names **and** the text inside them, favorites, recent files and your own virtual folders. Everything is
local: nothing is uploaded, and there is no network access. (Cloud *sync* and sharing are Phase 4; this feature only
*reads* folders that a sync client such as OneDrive keeps on disk.)

## What it does

* **Watched folders**: "Add folder…" (native folder dialog) or one click on a suggestion. Suggestions are only offered for
  folders that exist on this machine: OneDrive (`%OneDrive%`, `%OneDriveConsumer%`, `%OneDriveCommercial%`, `~/OneDrive*`,
  `~/Library/CloudStorage/OneDrive-*`), Google Drive for desktop (`X:\My Drive`, `~/Google Drive`,
  `~/Library/CloudStorage/GoogleDrive-*`), Dropbox (`~/Dropbox`, `%APPDATA%\Dropbox\info.json`, `%LOCALAPPDATA%`,
  `~/.dropbox/info.json`, CloudStorage), iCloud Drive (`~/iCloudDrive`, `Mobile Documents/com~apple~CloudDocs`), Box, and
  Documents / Downloads / Desktop. Overlapping folders are refused with a message (a file belongs to one watched folder).
* **Sidebar**: All files, Recent, Favorites; **Folders** (virtual, nested, drag and drop or "Add to folder…", "Projects/Invoices"
  makes both levels); **Watched folders** as a tree of their sub-folders.
* **List or thumbnails**, sortable by name / folder / size / date / pages / last opened, filterable ("Cloud only",
  "No text (scanned)", "Not searchable", "Too large"). The list is virtualised and paged from SQLite (100 rows per request),
  so 10,000+ files cost the same as 100.
* **Search**: *File names* filters as you type (case-, accent- and substring-insensitive, every word must match).
  *Text inside files* is a ranked (bm25) full-text search with highlighted snippets and page numbers:
  `annual report` (all words), `"annual report"` (phrase), `budget OR forecast`, `budget -draft` / `budget NOT draft`,
  `invoi*` (prefix), `( a OR b ) c`. AND/OR/NOT must be upper case. Accents fold both ways, CJK is a substring search.
  A search box never exposes FTS5 syntax: see "Query safety".
* **Opening**: Enter, double-click, or "Open" (several files at once: each in its own tab). "Open at page N" from a content
  hit opens the file on that page, opens the in-document Find bar and searches for the matched words
  (`useSearch`), so the term is highlighted. "Show in folder", "Favorite", "Add to folder…", "Remove from library…",
  "Index anyway" (for files over the size limit).
* **Keyboard**: the search box takes focus on open; ArrowDown moves into the list; arrows / Home / End / PageUp / PageDown move,
  Shift+arrows select a range, Space toggles, Ctrl/Cmd+A selects all loaded rows, Enter opens, Ctrl/Cmd+D toggles favorite,
  Delete removes from the library (asks first), Escape clears the search then closes. Tab stays inside the layer.

## Indexing (never on the UI thread)

`library:sync` is a background **job** (progress in the library's status bar and in the jobs tray, with Cancel). It runs in a
**worker thread** (`indexWorker.ts`) that does the folder scan and the text extraction; the main thread only writes to SQLite.

1. **Scan** (`scanner.ts`): recursive, skips hidden (`.x`), `node_modules`, `$RECYCLE.BIN`, `System Volume Information`,
   `AppData`; never follows a link out of the folder and never visits a directory twice (symlink/junction loops); caps depth
   (24) and files per folder (50,000) and says so in the folder's note; unreadable folders are counted, not fatal.
2. **Plan** (`shared/features/library/plan.ts`, pure): new / changed (size or mtime) / retry (pending, older extractor) /
   hydrated (was a cloud placeholder) / unchanged / missing. Deleted files are removed only after a `stat` confirms they are
   gone (a scan can be incomplete).
3. **Moves**: a "new" file with the same size and quick hash as a missing one is that file renamed/moved: same id, favorite,
   folders, text and thumbnail; nothing is re-extracted. A file whose timestamp changed but whose content did not is detected
   by the quick hash (SHA-1 of size + first/last 64 KB) and is not re-extracted either.
4. **Extract** (`extract.ts`): pdf.js **legacy build** in the worker (no DOM, no canvas), fonts/CMaps from the app's own
   `pdfjs` assets. Per-page text is cleaned (NFKC: ligatures; control/invisible characters removed) and stored one row per page.
   Password-protected, damaged, non-PDF and empty files are recorded as *not searchable* with the reason; image-only files as
   *no text – run OCR*. A file that takes >90 s or crashes the worker is abandoned and recorded; the indexer carries on.
   Results are committed file by file, so a cancel keeps everything finished and the next run resumes with the rest.
5. **Throttling**: after each file the worker sleeps ~35% of the time it just used (max 120 ms) so a big library never
   monopolises a core.

Freshness: `fs.watch` (recursive; canonical real path) per folder, debounced 1.5 s, plus a 10-minute rescan as fallback (network
drives, unsupported platforms). Watching can be switched off in the settings. After a cancel, watcher/periodic requests do not
resume that folder (reading files can itself raise change events on Windows); "Rescan", adding the folder or restarting does.
A crash-loop guard turns watching off if the app died right after creating watchers (libuv aborts the process natively when a
Windows watch path is spelled with 8.3 short names, which is why the canonical path is always used).

### Cloud placeholders (files on demand)

Never downloaded by indexing. `stat` (no content read) is used: a file with `size >= 1 KB` and **zero allocated blocks** is a
*suspect*. On Windows the suspects' attribute word is read with PowerShell's `Get-Item` (metadata only; paths are passed in a
UTF-8 file, never on the command line) and `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` (0x400000), `RECALL_ON_OPEN` (0x40000) or
`OFFLINE` (0x1000) make it a placeholder. If PowerShell is unavailable, or on macOS/Linux, a suspect counts as cloud-only
(skipping a local file costs nothing, downloading gigabytes does). macOS iCloud `.Name.pdf.icloud` stubs are recognised by name.
Placeholders show a cloud icon and "Cloud only", are not content-indexed, and are indexed automatically once they have been
downloaded. A file that was indexed and is later "freed up" keeps its text and gets the cloud flag. **Opening** a cloud file is
the user's request: the sync client downloads it and Epdf says so.

### Safety

* The renderer never supplies a path. Files are addressed by opaque refs (`f12` = library file, `r7` = recent file) that main
  validates against the database on every use (`access.ts`): the row must exist and not be hidden; its real path must lie
  inside the real path of its watched folder (a link leading out is refused); a recent file must still be a known recent; and the
  file must still start with `%PDF-`. Missing files are dropped from the index with a message.
* Query safety: every word/phrase is emitted as a quoted FTS5 string; column filters, `NEAR(`, `^`, stray quotes, `*` inside
  words and `-` are plain text; the operators AND/OR/NOT/parentheses are the only structure a user can add. Unit tests run
  injection strings through real SQLite.
* Everything shown is React text: snippets are structured parts (`{text, hit}`) rendered as `<mark>`/text, never HTML. File
  names lose bidi/zero-width/control characters.
* Files above the size limit (200 MB, setting) are not indexed unless the user asks ("Index anyway").
* "Remove from library" hides a file so a rescan does not bring it back (the PDF is never touched); per-folder "Remove folder…"
  deletes that folder's index; Settings ▸ "Rebuild index…" re-reads everything and keeps folders/favorites/library folders;
  "Forget everything…" clears folders, index, thumbnails and library folders. No action deletes a user file.

## Data (migration 5)

`library_roots`, `library_files` (one row per PDF: path, relative folder, name + folded name key, size, mtime, pages, hash,
`state` pending/indexed/no_text/unindexable/cloud/too_large, `cloud`, favorite, hidden, thumbnail key),
`library_collections` (tree) + `library_collection_files` (memberships), and the FTS5 table `library_text(text)` with
`unicode61 remove_diacritics 2`. **rowid = file_id × 2²⁰ + page**, so a file's pages are one contiguous range (cheap to
replace) and file/page of a hit are recovered arithmetically. Because that tokenizer does not split CJK, every Han/Kana
character is padded with spaces at index time and in queries (`spaceCjk`). Settings live in `ctx.kv('library')`.
Favorites: `library_files.favorite`, mirrored to `recent_files.favorite`; files opened from anywhere appear in Recent and can be
starred, but only files in a watched folder can be put into library folders.

## Thumbnails

Rendered in the **renderer** with the PDF.js already used by the viewer (its rendering runs in PDF.js's own worker), one at a
time, newest-visible first, only for rows on screen; main caches the PNG under `userData/library-thumbs/<id>.png` (keyed by
size+mtime, so an edited file gets a new picture). Chosen over a Node-side canvas because a canvas in Node needs a native
module (`@napi-rs/canvas`) or a WASM renderer that pdf.js does not support out of the box; this needs no new dependency and
no bundled binary. Cloud-only, password-protected and oversized files get a placeholder, never a picture.

## Limits and notes

* CJK text uses per-character tokens (substring search works; there is no word segmentation or ranking by words). Scripts without
  spaces that are not Han/Kana (e.g. Thai) are searched as whole runs.
* Hyphenated line breaks are not re-joined ("infor-\nmation" is two tokens).
* Password-protected PDFs are not indexed (there is no password prompt in the background).
* A file can belong to one watched folder only.
* Only the first 20,000 pages of a PDF are indexed.
* Recent files that are not in a watched folder have no text index (not searchable by content).
* Files whose folder is on a drive that is not connected stay in the library (flagged) and cannot be opened until it is back.

## Testing

* Unit (`tests/unit/library*.test.ts`): migration 5 (upgrade from 4, idempotent), FTS query building/escaping and real-SQLite
  behaviour, snippet sanitising, ranking, name/CJK/accent search, incremental planner, scanner (loops, links out of the folder,
  hidden folders, caps, unreadable folders), placeholder detection (attribute parsing, real PowerShell attribute reader),
  extraction (accents, CJK, encrypted, corrupt, image-only), sync (new/changed/deleted/moved/cancelled/vanished folder),
  service (queue, watchers, settings, thumbnails), the open gate (ref validation, symlink escape), folder suggestions with fake
  environments, and a scale test (`EPDF_SCALE_FILES=10000 npx vitest run tests/unit/libraryScale`).
* E2E `tests/e2e/library.spec.ts`: full flows in the real app incl. a 2,000-file library, keyboard-only use and axe scans.
  Test hooks (env): `EPDF_LIBRARY_PICK_FOLDER` (replaces the folder dialog), `EPDF_LIBRARY_WATCH_MS`, `EPDF_LIBRARY_START_MS`,
  `EPDF_LIBRARY_RESCAN_MS`, `EPDF_LIBRARY_THROTTLE_MS`.

## Manual test

1. File ▸ Library…, "Add folder…", pick a folder with PDFs: the list fills while the status bar shows "Indexing n of m".
2. Type part of a name (with or without accents). Switch to "Text inside files" and search a word from inside a PDF: the
   snippet highlights it, shows "Page N"; Enter opens the file at that page with the word highlighted.
3. Copy a new PDF into the folder / edit one / delete one: the list and search update within a few seconds.
4. Star a file, create "Projects/Invoices" through "Add to folder…", drag another file onto it.
5. Add a PDF that is scanned (no text), one that is password-protected and one that is damaged: each is listed with its reason.
6. If you use OneDrive/Dropbox files-on-demand, add that folder: online-only PDFs show "Cloud only" and are not downloaded;
   opening one downloads it.
