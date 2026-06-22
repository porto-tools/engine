#!/usr/bin/env sh
# sync-from-website.sh — reproduce the public engine snapshot from the website
# repo and prove it is byte-identical to what the site actually ships.
#
# This is the "no drift" guarantee: the public engine == the shipping engine,
# because the public copy is literally produced by copying src/engine/** out of
# the website repo and then re-hashing both trees to confirm zero differences.
#
# 0 dependencies. Plain POSIX sh + `cp` + node's built-in crypto (no npm install,
# no rsync requirement). Node is already a project prerequisite.
#
# Usage:
#   ./sync-from-website.sh [path-to-website-repo]
# Default website path: ../website (sibling of this staging dir).
#
# What it does:
#   1. Mirror  website/src/engine/**  ->  ./engine/**   (full replace; tests +
#      fixtures + .d.ts included — the firewall rule is "tests included").
#   2. Hash every file in BOTH trees (sha256) and diff the manifests.
#   3. Exit non-zero on ANY mismatch / extra / missing file. A clean exit is the
#      byte-identical proof.
#
# It does NOT push anything. Publishing porto-tools/engine is owner-gated and
# irreversible; this script only stages + verifies locally.

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
WEBSITE="${1:-$HERE/../website}"
SRC="$WEBSITE/src/engine"
DEST="$HERE/engine"

if [ ! -d "$SRC" ]; then
  echo "FAIL: engine source not found at: $SRC" >&2
  echo "Pass the website repo path as arg 1, e.g. ./sync-from-website.sh /path/to/website" >&2
  exit 2
fi

echo "Source : $SRC"
echo "Staging: $DEST"

# 1. Full replace of the staged snapshot. Wipe first so deletions in the source
#    are reflected (no stale files lingering in the public copy).
rm -rf "$DEST"
mkdir -p "$DEST"
# cp -R preserves the byte content of binaries (fixtures are real PDFs/images).
cp -R "$SRC/." "$DEST/"

# 2 + 3. Hash + compare both trees with node's built-in crypto. Manifests are a
#        sorted "sha256  relative/path" list per tree; a plain diff is the gate.
node "$HERE/verify-byte-identical.mjs" "$SRC" "$DEST"

echo "OK: snapshot synced and verified byte-identical."
