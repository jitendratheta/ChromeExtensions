#!/usr/bin/env bash
# Pack the extension into Searchlight.crx using the persistent key.
#
# Chrome refuses to pack a directory that contains a .pem (it would end up
# inside the CRX), so the key is COPIED out and the original is removed only
# for the duration of the pack, then restored from the copy. The copy is the
# safety net: even if a step fails, the key survives in the temp dir and the
# final verification refuses to succeed without key.pem back in place.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
KEY="$DIR/key.pem"
SAFE="$(mktemp -d)/key.pem"

[[ -f "$KEY" ]] || { echo "key.pem not found — first pack? Run chrome --pack-extension manually."; exit 1; }

cp "$KEY" "$SAFE"                      # safety copy FIRST
restore() {
  [[ -f "$KEY" ]] || cp "$SAFE" "$KEY"
  if [[ ! -f "$KEY" ]]; then
    echo "FATAL: key.pem could not be restored — copy is at $SAFE" >&2
    exit 90
  fi
}
trap restore EXIT
rm "$KEY"                              # hide from the packed payload

# Temporarily hide any previous crx from the packed payload as well.
CRX_BACKUP=""
if [[ -f "$DIR/Searchlight.crx" ]]; then
  CRX_BACKUP="$(mktemp -d)/Searchlight.crx"
  mv "$DIR/Searchlight.crx" "$CRX_BACKUP"
fi

"$CHROME" --no-startup-window --pack-extension="$DIR" --pack-extension-key="$SAFE"

mv "$(dirname "$DIR")/$(basename "$DIR").crx" "$DIR/Searchlight.crx"
rm -f "$CRX_BACKUP"

restore
[[ -f "$KEY" && -s "$KEY" ]] || { echo "FATAL: key.pem missing after pack" >&2; exit 91; }
echo "Packed: $DIR/Searchlight.crx (key verified in place)"
