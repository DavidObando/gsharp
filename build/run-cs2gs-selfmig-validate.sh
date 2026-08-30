#!/usr/bin/env bash
# Issue #3668, stage 2 of the sharded self-migration gate: validate ONE shard's
# apps against the already-migrated tree produced by
# run-cs2gs-selfmig-migrate.sh.
#
# Usage: run-cs2gs-selfmig-validate.sh <shard-name> <app-id> [<app-id> ...]
#
# Compile, ILVerify and test-parity are independent per app — that is the axis
# this shards on. The DISCOVERED app set stays the whole repository (identical
# --exclude list): `cs2gs validate --app` narrows what is executed, never what
# exists, because excluding a project another app project-references breaks
# reference resolution and manufactures phantom cascades.
#
# Inputs (from the migrate artifact, unpacked under $SELFMIG_GATE_ROOT):
#   migrated/               the migrated tree
#   runs/<runId>/           per-app validation-context.json manifests
#   migrate-run-dir.txt     the manifest run directory
# Outputs under $SELFMIG_GATE_ROOT/shard-<name>/:
#   run.json                this shard's partial run result
#   polished.tar.gz         the .gs files stage 2's `!!` polish pass rewrote
set -euo pipefail

if (( $# < 2 )); then
  echo "usage: $0 <shard-name> <app-id> [<app-id> ...]" >&2
  exit 2
fi

shard_name=$1
shift

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=build/selfmig-common.sh
source "$repo_root/build/selfmig-common.sh"
work_root=${SELFMIG_GATE_ROOT:-"${TMPDIR:-/tmp}/gsharp-cs2gs-selfmig"}
work_root=$(cd "$work_root" && pwd -P)
migrated_dir="$work_root/migrated"
manifest_run_dir=$(cat "$work_root/migrate-run-dir.txt")
shard_out="$work_root/shard-$shard_name"

if [[ ! -d "$migrated_dir" ]]; then
  echo "self-migration shard $shard_name: no migrated tree at $migrated_dir." >&2
  exit 1
fi

# The migrate artifact records absolute paths from the migrate runner; on a
# fresh runner the run directory lands at the same absolute location, but be
# explicit rather than trusting that.
if [[ ! -d "$manifest_run_dir" ]]; then
  manifest_run_dir=$(find "$work_root/runs" -maxdepth 2 -name run.json | sort | tail -1)
  manifest_run_dir=${manifest_run_dir%/run.json}
fi

rm -rf "$shard_out"
mkdir -p "$shard_out"

selfmig_build_prerequisites

# Snapshot the tree so stage 2's `!!` polish rewrites can be shipped back to
# the gate job as a delta (see run-cs2gs-selfmig-gate.sh).
selfmig_hash_tree "$migrated_dir" > "$shard_out/pre.sha256"

app_args=()
for app in "$@"; do
  app_args+=(--app "$app")
done

set +e
dotnet "$repo_root/out/bin/Release/Cs2Gs.Cli/cs2gs.dll" validate \
  --corpus "$repo_root" \
  --migrated "$migrated_dir" \
  --artifacts "$shard_out/runs" \
  --manifests "$manifest_run_dir" \
  --config Release \
  "${selfmig_excludes[@]}" \
  "${app_args[@]}" \
  | tee "$shard_out/validate.log"
validate_exit=${PIPESTATUS[0]}
set -e

# Exit 1 means "apps failed a stage", which is exactly what the gate job is
# there to judge; only exit 2 (tool error) fails the shard job itself.
if (( validate_exit >= 2 )); then
  echo "self-migration shard $shard_name: cs2gs validate errored (exit $validate_exit)." >&2
  exit "$validate_exit"
fi

shard_run_json=$(find "$shard_out/runs" -maxdepth 2 -name run.json | sort | tail -1)
if [[ -z "$shard_run_json" ]]; then
  echo "self-migration shard $shard_name: no run.json produced." >&2
  exit 1
fi
cp "$shard_run_json" "$shard_out/run.json"

selfmig_hash_tree "$migrated_dir" > "$shard_out/post.sha256"

# Files whose hash changed (or that appeared) during validation — i.e. what the
# polish pass rewrote. Almost always a small handful.
awk 'NR==FNR { before[$2] = $1; next } (!($2 in before)) || before[$2] != $1 { print $2 }' \
  "$shard_out/pre.sha256" "$shard_out/post.sha256" > "$shard_out/polished.txt"
polished_count=$(wc -l < "$shard_out/polished.txt" | tr -d ' ')
echo "self-migration shard $shard_name: $polished_count .gs file(s) rewritten by the polish pass."
if (( polished_count > 0 )); then
  tar -czf "$shard_out/polished.tar.gz" -C "$migrated_dir" -T "$shard_out/polished.txt"
fi

green=$(jq '[.apps[] | select(.succeeded)] | length' "$shard_out/run.json")
total=$(jq '.apps | length' "$shard_out/run.json")
echo "self-migration shard $shard_name: $green/$total apps green."
