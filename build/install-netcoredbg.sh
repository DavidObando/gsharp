#!/usr/bin/env bash

set -euo pipefail

version=3.2.0-1092
expected_sha256=080eb3b2d2152465f599d3b33d1ee6e747794e11cc0a3773ec689f5e5f2c5afa
url="https://github.com/Samsung/netcoredbg/releases/download/${version}/netcoredbg-linux-amd64.tar.gz"

temp_dir=${RUNNER_TEMP:-"$PWD/out/tmp"}
archive=$temp_dir/netcoredbg.tar.gz
install_dir=$HOME/.tools/netcoredbg

mkdir -p "$temp_dir" "$install_dir"
curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 180 \
  "$url" -o "$archive"

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256=$(sha256sum "$archive" | awk '{print $1}')
else
  actual_sha256=$(shasum -a 256 "$archive" | awk '{print $1}')
fi

if [[ $actual_sha256 != "$expected_sha256" ]]; then
  echo "::error::netcoredbg archive SHA-256 mismatch for $url: expected $expected_sha256, got $actual_sha256" >&2
  exit 1
fi

tar -xzf "$archive" -C "$install_dir" --strip-components=1

binary=$install_dir/netcoredbg
if [[ ! -x $binary ]]; then
  echo "::error::netcoredbg archive extracted but $binary is missing or not executable. Extracted layout:" >&2
  ls -laR "$install_dir" >&2
  exit 1
fi

if ! installed_version=$("$binary" --version 2>&1); then
  echo "::error::netcoredbg was extracted to $binary but failed to run: $installed_version" >&2
  exit 1
fi

echo "Installed $installed_version"
if [[ -n ${GITHUB_PATH:-} ]]; then
  echo "$install_dir" >> "$GITHUB_PATH"
fi
