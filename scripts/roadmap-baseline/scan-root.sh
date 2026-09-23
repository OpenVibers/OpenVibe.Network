#!/usr/bin/env bash
# Build a scan root of origin/main checkouts for the Wave 0 baseline, without touching the sibling
# working trees (other people and agents work in them; one may be on a branch or hold uncommitted work).
#
#   scripts/roadmap-baseline/scan-root.sh <out-dir> [--fetch] [--src <dir>]
#   OPENVIBE_ROOT=<out-dir> node scripts/roadmap-baseline/generate.js
#
# For every git repository under --src (default: the parent of this repo) it keeps a clone at
# <out-dir>/<name> that shares the sibling's objects (git clone --shared), copies the sibling's
# remote-tracking refs, and checks out origin/main as `main`. --fetch first runs `git fetch origin` in
# each sibling, which only updates its remote-tracking refs. Nothing in a sibling's working tree,
# index or branches changes.
set -euo pipefail
OUT=""; FETCH=0; SRC="$(cd "$(dirname "$0")/../../.." && pwd)"
while [ $# -gt 0 ]; do
    case "$1" in
        --fetch) FETCH=1 ;;
        --src) SRC="$(cd "$2" && pwd)"; shift ;;
        -*) echo "unknown option $1" >&2; exit 64 ;;
        *) OUT="$1" ;;
    esac
    shift
done
[ -n "$OUT" ] || { echo "usage: $0 <out-dir> [--fetch] [--src <dir>]" >&2; exit 64; }
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
[ "$(dirname "$OUT")" != "$SRC" ] && [ "$OUT" != "$SRC" ] || { echo "refusing: <out-dir> must not be $SRC or one of its repositories" >&2; exit 64; }

for dir in "$SRC"/*/; do
    name="$(basename "$dir")"
    [ -e "$dir/.git" ] || continue
    git -C "$dir" rev-parse --verify -q origin/main >/dev/null || { [ "$FETCH" = 1 ] || { echo "skip $name (no origin/main)"; continue; }; }
    [ "$FETCH" = 1 ] && git -C "$dir" fetch --quiet origin || true
    git -C "$dir" rev-parse --verify -q origin/main >/dev/null || { echo "skip $name (no origin/main)"; continue; }
    dst="$OUT/$name"
    [ -d "$dst/.git" ] || git clone --quiet --shared --no-checkout "$dir" "$dst"
    git -C "$dst" fetch --quiet --no-tags "$dir" '+refs/remotes/origin/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*'
    git -C "$dst" checkout --quiet --force -B main refs/remotes/origin/main
    git -C "$dst" clean --quiet -fdx
    echo "$name $(git -C "$dst" rev-parse --short HEAD)"
done
