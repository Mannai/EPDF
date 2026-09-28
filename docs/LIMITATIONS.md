# Known limitations

What Epdf 1.0.6-beta.1 does not do yet, and what has not been verified. Each feature's page in
[`docs/features/`](features/) has the details; this page collects the ones that matter most.

## Platforms and distribution

- **Windows and Linux.** The Linux build (.deb and AppImage, x64) was developed and tested on Ubuntu 26.04 under WSL2
  only: other distributions, desktops (KDE, XFCE...), Wayland sessions and ARM were not tried. On Linux, scanners
  are not supported (webcam and phone are), HEIC pictures need `heif-convert` or ImageMagick, saving signatures needs
  a desktop keyring, and there are no file-manager "Convert to PDF" entries.
- **macOS** is configured but was never built or run: the universal `.dmg`, Dock menu, `open-file` handling, the
  macOS HEIC decoder and key storage are written but untested.
- **The beta is unsigned**, so Windows SmartScreen warns on download. The signing pipeline works with a test
  certificate; see [Code signing](DEVELOPMENT.md#code-signing).
- **Auto-update** was tested end to end against a local server (update, relaunch, tampered download refused), but
  not with a signed build. Since 1.0.8 the feed is the public GitHub releases of Mannai/epdf-releases; an in-app
  update from one of those releases to the next has not been observed yet (1.0.8 is the first version that reads
  it). Not tested: AppImage self-update, and updating an MSI install (the updater runs the NSIS installer).
- **Windows installers** were installed and uninstalled on Windows 11 (files, shortcuts, `.pdf` association,
  uninstall entry, Explorer entries, full cleanup; NSIS and MSI). Not tested: an all-users (admin) install, other
  Windows versions. The MSI has no Explorer right-click entries. The installer's Arabic/French/German/Spanish wording
  is a draft that needs native review.
- **Epdf's own interface is in English.** Documents in any language work (below); translating the menus and dialogs
  is not in this release.

## Documents in Arabic and other scripts

- Right-to-left text in existing PDFs is selected, copied, searched and edited in logical order through the
  [page text model](page-text.md). It was checked on files from LibreOffice, Chromium, Word and Epdf itself, and on real
  Arabic PDFs (UN, WHO, Internet Archive scans). Files whose fonts carry no usable Unicode mapping, or map ligatures to
  the wrong letters (some bioPDF and Word 2010 output), cannot be read correctly; the page text model reports them
  instead of guessing. Vertical writing is not supported.
- Text Epdf *writes* (form fields, Add text, stamps, text boxes, headers/footers, watermarks, redaction overlays, new
  text in the editor) is shaped by the [text engine](text-engine.md). Acrobat's handling of Epdf's Arabic form fields
  was not tested.
- The Arabic in the app (stamps, dates, typed signatures) and in documents Epdf produces still needs a review by a
  native speaker.

## Features

- **OCR** — English is built in; 15 more languages (including Arabic, Persian and Urdu) are downloaded on demand. The
  recognized text layer can't be viewed or corrected in the app. See [OCR](features/ocr.md).
- **Other software** — output was validated structurally and rendered with PDF.js and Windows' own PDF engine; it was
  never opened in Acrobat, Word/Excel/PowerPoint or Preview. Office conversion was compared against LibreOffice, not
  Microsoft Office.
- **Editing existing content** was mostly tested on generated files that imitate Word, Chrome and LibreOffice output.
  Set `EPDF_CORPUS_DIR` to run the opt-in corpus test on your own files.
- **Printing** — physical printing and the native print dialog were not exercised; printed pages are rasterized.
- **Password-protected PDFs** can be opened, edited and saved (staying encrypted), but Combine and batch file-size
  reduction skip them, and certificate-based (public-key) encryption is not supported. PDF permission flags are
  advisory in other software (see [Security](features/security.md)).
- **Hardware** — no real scanner, phone or webcam was available; the Windows scanner script, webcam preview and phone
  upload were tested against stubs, a fake camera and real HTTP requests. Cloud-folder detection in the library was
  tested with fakes, not real OneDrive/Google Drive/Dropbox folders.
- **Form builder** and **redaction** were tested on generated documents. Redaction verifies its own result and refuses
  when it cannot be sure; [Redaction](features/redact.md) states exactly what is and is not removed. Copies outside
  Epdf's data folder (backups, the original left after Save As) are not controlled.
- **Compression** does not linearize ("Fast Web View").
- **HEIC** pictures depend on the Windows HEIF extension; everything else is built in.
- Old binary Office formats (`.doc`, `.xls`, `.ppt`) are not converted; save them as `.docx/.xlsx/.pptx` first.
- A spreadsheet that declares absurd repeat counts is capped at 512 columns × 2000 rows; converting that still takes
  about 40 s.
- Dragging a tab out of the window is not implemented; use **Document ▸ Move Tab to New Window**.
- Cloud features (signature requests, sharing, shared review) are not part of this release.
