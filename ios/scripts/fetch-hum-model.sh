#!/usr/bin/env bash
# Fetch the Basic Pitch Core ML model for native Hum into ios/HumModel/BasicPitchPoly.mlpackage (committed; rerun to verify or refresh).
# Spotify basic-pitch ICASSP 2022 weights, Apache-2.0, pinned to the same commit and sha256s as earsheet's models.lock.
set -euo pipefail
cd "$(dirname "$0")/.."
base=https://raw.githubusercontent.com/spotify/basic-pitch/a5ab7392dfb4b3f1d21f7c6106a42cb2a9138799/basic_pitch/saved_models/icassp_2022/nmp.mlpackage
dest=HumModel/BasicPitchPoly.mlpackage
while read -r sha rel; do
  out="$dest/$rel"; mkdir -p "$(dirname "$out")"
  if [ ! -f "$out" ] || ! echo "$sha  $out" | shasum -a 256 -c --status 2>/dev/null; then
    curl -fsSL "$base/$rel" -o "$out"
    echo "$sha  $out" | shasum -a 256 -c --status || { echo "sha256 mismatch: $rel" >&2; exit 1; }
  fi
done <<'LIST'
c1fa5ef8acc34703edcd4e90e9a8640bd4673d9f3a68753c3b9d1ca0365e2928 Manifest.json
af7bf7d49bc167e0bf0c30aa2ca6b432c3e10df048d2dd4173ff3a738c020858 Data/com.apple.CoreML/model.mlmodel
691a6b63c7ddcdde0ee131ff3986dcb1250df47cd738612efde966ba9b4c99cd Data/com.apple.CoreML/weights/weight.bin
LIST
curl -fsSL https://raw.githubusercontent.com/spotify/basic-pitch/a5ab7392dfb4b3f1d21f7c6106a42cb2a9138799/LICENSE -o HumModel/LICENSE-basic-pitch.txt
echo "hum model ready -> $dest ($(du -sh "$dest" | cut -f1))"
