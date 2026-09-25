#!/bin/sh
# Builds the macOS scanner helper (epdf-mac-scan) as a universal (arm64 + x86_64) binary and puts it where Epdf and
# electron-builder look for native helpers:
#   resources/bin/darwin-arm64/  and  resources/bin/darwin-x64/   (dev: `npm run dev` uses process.platform-arch)
#   resources/bin/mac-arm64/     and  resources/bin/mac-x64/      (electron-builder's ${os}-${arch} for extraResources)
#
# Needs Xcode command line tools (swiftc) on a Mac. Not run by the authors: see README.md ("Status").
set -eu
cd "$(dirname "$0")"
ROOT="$(cd ../../.. && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for ARCH in arm64 x86_64; do
  swiftc -O -target "$ARCH-apple-macos11" -framework ImageCaptureCore -framework Foundation \
    -o "$TMP/epdf-mac-scan-$ARCH" main.swift
done
lipo -create -output "$TMP/epdf-mac-scan" "$TMP/epdf-mac-scan-arm64" "$TMP/epdf-mac-scan-x86_64"
# Ad-hoc signature so it runs locally; the release build re-signs it with the Developer ID (see README.md).
codesign --force --sign - "$TMP/epdf-mac-scan"

for DIR in darwin-arm64 darwin-x64 mac-arm64 mac-x64; do
  mkdir -p "$ROOT/resources/bin/$DIR"
  cp "$TMP/epdf-mac-scan" "$ROOT/resources/bin/$DIR/epdf-mac-scan"
  chmod 755 "$ROOT/resources/bin/$DIR/epdf-mac-scan"
done
echo "Built epdf-mac-scan into resources/bin/{darwin,mac}-{arm64,x64}/"
