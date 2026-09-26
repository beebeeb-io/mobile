#!/usr/bin/env bash
# Fetches the RAW camera samples that are too large to commit (>5MB) directly
# from raw.pixls.us (CC0-licensed sample repository — see SOURCES.md for the
# per-file license link and provenance). Verifies each download's sha256
# against the pinned value before keeping it.
#
# sample.nef and sample.dng are committed directly (both <5MB) and are NOT
# fetched by this script.
#
# Usage: ./fetch-raw.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

fetch() {
  local name="$1" url="$2" sha="$3"
  if [ -f "$name" ]; then
    local existing
    existing="$(shasum -a 256 "$name" | awk '{print $1}')"
    if [ "$existing" = "$sha" ]; then
      echo "OK (cached): $name"
      return 0
    fi
    echo "Stale/corrupt $name — re-downloading."
    rm -f "$name"
  fi
  echo "Fetching $name from raw.pixls.us ..."
  curl -sL --fail --max-time 120 -o "$name" "$url"
  local got
  got="$(shasum -a 256 "$name" | awk '{print $1}')"
  if [ "$got" != "$sha" ]; then
    echo "CHECKSUM MISMATCH for $name: expected $sha, got $got" >&2
    rm -f "$name"
    exit 1
  fi
  echo "OK: $name ($sha)"
}

# Canon CR2 — Canon EOS 40D, sRAW2 mode, CC0 (see SOURCES.md)
fetch "sample.cr2" \
  "https://raw.pixls.us/getfile.php/2102/nice/Canon%20-%20EOS%2040D%20-%20sRAW2%20(sRAW)%20(3:2).CR2" \
  "ba644e7dd2abe74eca260e67f0206ff113bf0f62e710f8130611e964d6be5bf1"

# Canon CR3 — Canon EOS R6, CC0
fetch "sample.cr3" \
  "https://raw.pixls.us/getfile.php/4659/nice/Canon%20-%20EOS%20R6%20-%203:2.CR3" \
  "74abb0a113d075ad9887a058082f40dd2a938c4813a08474d82356f11a027778"

# Sony ARW — Sony ILCE-7S, 14-bit compressed, CC0
fetch "sample.arw" \
  "https://raw.pixls.us/getfile.php/1582/nice/Sony%20-%20ILCE-7S%20-%2014bit%2014bit%20compressed%20(3:2).ARW" \
  "a35ebb2fbec929daa5beb20d1ce5c15a8aac7b1a7a231455387f3df8a7442e07"

# Fujifilm RAF — Fujifilm FinePix S5000, CC0
fetch "sample.raf" \
  "https://raw.pixls.us/getfile.php/2726/nice/Fujifilm%20-%20FinePix%20S5000%20-%204:3.RAF" \
  "dabd5e74521a6980156be9fd4b88d0c37b0fe4d0e0e6f5c12db8cffff1b76297"

echo "Done. See SOURCES.md for license + provenance details."
