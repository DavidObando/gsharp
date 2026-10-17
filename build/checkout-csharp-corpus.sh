#!/usr/bin/env bash
# Checks out the C# corpus of the cs2gs apps nightly's gsharp-csharp leg: the
# branch and commit pinned in tools/cs2gs/external/gsharp-csharp.json (the
# final C# tree, cs2gs/csharp-0.4), as a detached worktree of this checkout at
# <dir>. The leg passes <dir> as SELFMIG_SOURCE_ROOT (build/selfmig-common.sh).
#
#   build/checkout-csharp-corpus.sh <dir>
#
# Fails when the pinned commit is not on the pinned branch, so a pin bump that
# forgot to push its back-port cannot silently migrate a commit nobody can find
# on the branch again. Used by every job that reads the corpus (translate and
# each validate shard), so they all see the identical tree at the same path.
set -euo pipefail

if (( $# != 1 )); then
  echo "usage: $0 <dir>" >&2
  exit 2
fi
dest=$1
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
manifest="$repo_root/tools/cs2gs/external/gsharp-csharp.json"
repository=$(jq -er '.repository' "$manifest")
branch=$(jq -er '.branch' "$manifest")
pinned=$(jq -er '.commit' "$manifest")

if [[ -e "$dest" ]]; then
  echo "checkout-csharp-corpus: '$dest' already exists." >&2
  exit 2
fi

tracking="refs/cs2gs-corpus/$branch"
git -C "$repo_root" fetch --quiet "$repository" "+refs/heads/$branch:$tracking"
if ! git -C "$repo_root" merge-base --is-ancestor "$pinned" "$tracking"; then
  echo "checkout-csharp-corpus: pinned commit $pinned is not on $branch ($repository)." >&2
  exit 1
fi
git -C "$repo_root" worktree add --quiet --detach "$dest" "$pinned"
echo "C# corpus: $branch at $(git -C "$dest" rev-parse HEAD) -> $dest"
