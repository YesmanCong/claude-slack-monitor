#!/usr/bin/env bash
set -euo pipefail

upstream_url=https://github.com/gammons/slk.git
upstream_commit=81dcdb053ccf525e6a320a0954192fa4ece81a0a
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="$(cd -- "$script_dir/.." && pwd)/.slk-bin"

for tool in git go; do
  if ! command -v "$tool" >/dev/null; then
    printf 'Required command missing: %s\n' "$tool" >&2
    exit 1
  fi
done

mkdir -p -- "$bin_dir"
if [[ -d "$bin_dir/slk" ]]; then
  printf 'Expected a file at %s/slk, found a directory\n' "$bin_dir" >&2
  exit 1
fi
build_dir="$(mktemp -d "$bin_dir/.build.XXXXXX")"
trap 'find "$build_dir" -depth -delete' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

repo_dir="$build_dir/source"
git init -q "$repo_dir"
git -C "$repo_dir" fetch -q --depth 1 --no-tags "$upstream_url" "$upstream_commit"
git -C "$repo_dir" checkout -q --detach "$upstream_commit"
git -C "$repo_dir" apply "$script_dir/recent.patch"
(
  cd -- "$repo_dir"
  go build -trimpath -o "$build_dir/slk" ./cmd/slk
)
mv -f -- "$build_dir/slk" "$bin_dir/slk"
printf 'slk installed at %s/slk\n' "$bin_dir"
