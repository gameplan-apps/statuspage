#!/usr/bin/env bash
#
# Pull the canonical Upptime workflows into .github/workflows/.
#
# These are fetched rather than hand-written on purpose: Upptime pins action
# versions in its own template and bumps them over time. Copying them by hand
# means shipping a stale, subtly-wrong set. This grabs the real ones.
#
# Our own workflow (maintenance-mirror.yml) is never touched.
#
# Run once at setup, and again whenever you want to re-sync with upstream.

set -euo pipefail

TEMPLATE_TARBALL="https://api.github.com/repos/upptime/upptime/tarball/master"
DEST=".github/workflows"
OURS="maintenance-mirror.yml"

cd "$(dirname "$0")/.."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching the Upptime template…"
curl -fsSL "$TEMPLATE_TARBALL" -o "$TMP/upptime.tar.gz"
tar -xzf "$TMP/upptime.tar.gz" -C "$TMP"

# Tarball unpacks into upptime-upptime-<sha>/, so workflows sit three levels down.
SRC="$(find "$TMP" -maxdepth 4 -type d -path '*/.github/workflows' | head -1)"
if [ -z "$SRC" ]; then
  echo "Could not find .github/workflows in the template tarball. Aborting." >&2
  exit 1
fi

mkdir -p "$DEST"
copied=0
for f in "$SRC"/*.yml; do
  base="$(basename "$f")"
  [ "$base" = "$OURS" ] && continue
  cp "$f" "$DEST/$base"
  echo "  + $base"
  copied=$((copied + 1))
done

echo
echo "Copied $copied workflow(s) into $DEST."
echo "Ours ($OURS) left untouched."
echo
echo "Next: set the GH_PAT secret (see SETUP.md) — the Upptime workflows will"
echo "fail without it, because they commit results back to this repo."
