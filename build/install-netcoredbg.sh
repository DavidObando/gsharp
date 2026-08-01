#!/usr/bin/env bash

set -euo pipefail

api_url=https://api.github.com/repos/Samsung/netcoredbg/releases/latest
response=
url=

for attempt in 1 2 3; do
  if response=$(curl -sSL --connect-timeout 15 --max-time 60 \
    -H "Authorization: Bearer ${GITHUB_TOKEN:?GITHUB_TOKEN is required}" \
    "$api_url"); then
    while IFS= read -r line; do
      if [[ $line =~ \"browser_download_url\"[[:space:]]*:[[:space:]]*\"([^\"]*linux-amd64\.tar\.gz)\" ]]; then
        url=${BASH_REMATCH[1]}
        break
      fi
    done <<< "$response"
  fi

  if [[ -n $url ]]; then
    break
  fi

  if (( attempt < 3 )); then
    delay=$((attempt * 2))
    echo "::warning::netcoredbg release lookup returned no linux-amd64 asset (attempt $attempt/3); GitHub API rate limiting is likely. Retrying in ${delay}s." >&2
    sleep "$delay"
  fi
done

if [[ -z $url ]]; then
  echo "::error::Unable to resolve the netcoredbg linux-amd64 release after 3 attempts. GitHub API rate limiting is likely; this is a CI infrastructure failure, not a G# test failure." >&2
  echo "GitHub API response body:" >&2
  printf '%s\n' "${response:-<empty response>}" >&2
  exit 1
fi

temp_dir=${RUNNER_TEMP:-"$PWD/out/tmp"}
archive=$temp_dir/netcoredbg.tar.gz
install_dir=$HOME/.tools/netcoredbg

mkdir -p "$temp_dir" "$install_dir"
curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 180 \
  "$url" -o "$archive"
tar -xzf "$archive" -C "$install_dir" --strip-components=1
echo "$install_dir" >> "$GITHUB_PATH"
