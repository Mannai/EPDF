#!/bin/sh
# Builds the macOS scanner helper (epdf-mac-scan) as one universal (arm64 + x86_64) binary and puts it where Epdf and
# electron-builder look for native helpers:
#   resources/bin/darwin-arm64/  and  resources/bin/darwin-x64/   (dev: `npm run dev` uses process.platform-arch)
#   resources/bin/mac-arm64/     and  resources/bin/mac-x64/      (electron-builder's ${os}-${arch} for extraResources)
#
# Needs only clang from the Command Line Tools (`xcode-select --install`); no Xcode, no Swift. `npm run dist:mac` runs it.
set -eu
cd "$(dirname "$0")"
ROOT="$(cd ../../.. && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# macOS 13 is the oldest version Epdf supports (docs/DEVELOPMENT.md).
clang -fobjc-arc -fmodules -O2 -Wall -Wextra -Wno-unused-parameter \
  -arch arm64 -arch x86_64 -mmacosx-version-min=13.0 \
  -framework Foundation -framework ImageCaptureCore \
  -o "$TMP/epdf-mac-scan" main.m
# Ad-hoc signature so it runs locally; electron-builder signs it again inside the app (with the app's identity).
codesign --force --sign - "$TMP/epdf-mac-scan"

for DIR in darwin-arm64 darwin-x64 mac-arm64 mac-x64; do
  mkdir -p "$ROOT/resources/bin/$DIR"
  cp "$TMP/epdf-mac-scan" "$ROOT/resources/bin/$DIR/epdf-mac-scan"
  chmod 755 "$ROOT/resources/bin/$DIR/epdf-mac-scan"
done
echo "Built epdf-mac-scan ($(lipo -archs "$TMP/epdf-mac-scan")) into resources/bin/{darwin,mac}-{arm64,x64}/"
