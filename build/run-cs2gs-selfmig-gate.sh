#!/usr/bin/env bash
# Issue #3668, stage 3 of the sharded self-migration gate: merge the shard
# results and apply the ratcheting baseline in tools/cs2gs/selfmig-baseline.json.
#
# Usage: run-cs2gs-selfmig-gate.sh <migrate-artifact-dir> <shards-dir>
#
#   <migrate-artifact-dir>  the unpacked migrate artifact: migrated/, runs/,
#                           metrics.json, migrate-run-dir.txt
#   <shards-dir>            a directory containing one subdirectory per shard,
#                           each holding shard-run.json and (optionally)
#                           polished.tar.gz
#
# The merge reconstructs exactly the per-app verdicts a single whole run would
# have produced: the translate stage comes from the migrate pass, stages 2-4
# from the shard that owned the app, and an app that failed translate keeps the
# whole run's shape (translate FAIL, the rest skipped) without ever having been
# handed to a shard. The polish deltas are replayed over the migrated tree
# before the readability metrics are re-measured, because stage 2 strips `!!`
# spans that gsc proved redundant and a whole run measures the tree AFTER that.
#
# Output format is a contract: the summary line, the step-summary table and the
# `GATE: ...` lines are identical to the classic single-job gate.
set -euo pipefail

if (( $# != 2 )); then
  echo "usage: $0 <migrate-artifact-dir> <shards-dir>" >&2
  exit 2
fi

migrate_dir=$(cd "$1" && pwd -P)
shards_dir=$(cd "$2" && pwd -P)

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=build/selfmig-common.sh
source "$repo_root/build/selfmig-common.sh"
baseline="$repo_root/tools/cs2gs/selfmig-baseline.json"
migrated_dir="$migrate_dir/migrated"

migrate_run_json=$(find "$migrate_dir/runs" -maxdepth 2 -name run.json | sort | tail -1)
if [[ -z "$migrate_run_json" ]]; then
  echo "self-migration gate: the migrate artifact carries no run.json." >&2
  exit 1
fi

shard_run_jsons=()
while IFS= read -r path; do
  shard_run_jsons+=("$path")
done < <(find "$shards_dir" -name shard-run.json | sort)

if (( ${#shard_run_jsons[@]} == 0 )); then
  echo "self-migration gate: no shard-run.json found under $shards_dir." >&2
  exit 1
fi

merged="$migrate_dir/run.merged.json"
python3 "$repo_root/build/merge-selfmig-runs.py" \
  --migrate "$migrate_run_json" \
  --out "$merged" \
  "${shard_run_jsons[@]}"

# Replay each shard's stage-2 `!!` polish rewrites onto the migrated tree.
# Overlapping rewrites of a shared file are last-one-wins, exactly as they are
# within a single whole run, where whichever app compiles last leaves the file.
shopt -s nullglob
for polished in "$shards_dir"/*/polished.tar.gz; do
  echo "gate: replaying polish delta $polished"
  tar -xzf "$polished" -C "$migrated_dir"
done
shopt -u nullglob

# Issue #3721: publish the per-app durations the shards measured, in the shape
# build/selfmig-shard-costs.json wants, so refreshing the checked-in map is a
# copy of one artifact file. Advisory: a shard that produced no cost file (an
# older shard job, a crash before the derive step) just contributes nothing.
shopt -s nullglob
shard_cost_jsons=("$shards_dir"/*/shard-costs.json)
shopt -u nullglob
costs="$migrate_dir/selfmig-shard-costs.json"
if (( ${#shard_cost_jsons[@]} > 0 )); then
  jq -s --arg runId "$(jq -r '.runId' "$merged")" \
    '{schema: 1, runId: $runId,
      note: "Per-app validation wall time in seconds (issue #3721). Copy over build/selfmig-shard-costs.json to reseed the shard planner.",
      apps: (reduce .[] as $shard ({}; . + $shard))}' \
    "${shard_cost_jsons[@]}" > "$costs"
  echo "gate: recorded durations for $(jq '.apps | length' "$costs") app(s) in $costs"
else
  echo "gate: no shard cost files; leaving the checked-in duration map alone." >&2
  echo '{"schema":1,"apps":{}}' > "$costs"
fi

green=$(jq '[.apps[] | select(.succeeded)] | length' "$merged")
total=$(jq '.apps | length' "$merged")

selfmig_measure "$migrated_dir"
selfmig_apply_baseline "$baseline" "$green" "$total"
