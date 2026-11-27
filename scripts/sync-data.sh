#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [--dry-run] REMOTE:BUCKET PREFIX" >&2
  echo "Example: $0 --dry-run r2:peaindex peaindex" >&2
  exit 2
}

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi
[[ $# -eq 2 ]] || usage
REMOTE=$1
[[ "$REMOTE" =~ ^[[:alnum:]_][[:alnum:]_.[:space:]-]*:[[:alnum:]][[:alnum:]._-]*$ ]] || usage
PREFIX=$2
while [[ "$PREFIX" == /* ]]; do PREFIX=${PREFIX#/}; done
while [[ "$PREFIX" == */ ]]; do PREFIX=${PREFIX%/}; done
DESTINATION="$REMOTE${PREFIX:+/$PREFIX}"
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DATA_ROOT="$ROOT/external-data"
CATALOG="$DATA_ROOT/catalog.json"
GZIP="$DATA_ROOT/catalog.json.gz"
[[ -f "$CATALOG" && -f "$GZIP" ]] || { echo "external-data catalog files are required" >&2; exit 1; }

STAGE=$(mktemp -d)
trap 'rm -f -- "$STAGE/catalog.json" "$STAGE/catalog.json.gz"; rmdir -- "$STAGE"' EXIT
cp "$CATALOG" "$GZIP" "$STAGE/"
GENERATION=$(python3 - "$STAGE" <<'PY'
import gzip
import json
from pathlib import Path
import re
import sys

stage = Path(sys.argv[1])
plain = (stage / "catalog.json").read_bytes()
if plain != gzip.decompress((stage / "catalog.json.gz").read_bytes()):
    raise SystemExit("catalog.json and catalog.json.gz differ")
generation = json.loads(plain).get("generation")
if not isinstance(generation, str) or not re.fullmatch(r"[a-f0-9]{20}", generation):
    raise SystemExit("Invalid catalog generation")
print(generation)
PY
)
LIBRARY="$DATA_ROOT/library/$GENERATION"
[[ -d "$LIBRARY" && -f "$LIBRARY/build-report.json" ]] || { echo "Missing generation: $GENERATION" >&2; exit 1; }

RCLONE=(rclone)
if (( DRY_RUN )); then RCLONE+=(--dry-run); fi

upload_catalog() {
  local name=$1 content_type=$2
  "${RCLONE[@]}" copyto --transfers 32 --ignore-times \
    --header-upload "Content-Type: $content_type" \
    --header-upload 'Cache-Control: no-cache' \
    "$STAGE/$name" "$DESTINATION/$name"
}

"${RCLONE[@]}" copy --transfers 32 --checksum --immutable \
  --include '/gene/*.json' --include '/disease/*.json' --include '/evidence/*.json' \
  --include '/build-report.json' --include '/source-fields.json' --include '/review-adjustments.json' \
  --header-upload 'Content-Type: application/json' \
  --header-upload 'Cache-Control: public, max-age=31536000, immutable' \
  "$LIBRARY" "$DESTINATION/library/$GENERATION"
upload_catalog catalog.json application/json
upload_catalog catalog.json.gz application/gzip
if (( DRY_RUN )); then
  echo "Dry run completed for generation $GENERATION at $DESTINATION"
else
  echo "Published generation $GENERATION to $DESTINATION"
fi
