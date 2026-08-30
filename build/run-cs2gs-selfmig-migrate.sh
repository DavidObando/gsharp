#!/usr/bin/env bash
# Issue #3668, stage 1 of the sharded self-migration gate: ONE whole-repository
# translate pass.
#
# Translation deliberately is NOT sharded. Linked sources (e.g.
# test/Shared/EmittedOracle.cs) are compiled into several projects, and
# TranslateStage cross-checks that each such file translates identically in all
# of them ("translates differently in multiple projects"). That guard only
# exists when every project translates in the same process, so this job
# migrates the whole repo exactly as the classic single-job gate does — it just
# stops after stage 1 and hands stages 2-4 to `cs2gs validate` shards.
#
# Outputs, all under $SELFMIG_GATE_ROOT (default /tmp/gsharp-cs2gs-selfmig):
#   migrated/        the migrated G# tree (uploaded for the shards and the gate)
#   runs/<runId>/    per-app validation-context.json manifests + run.json
#   migrate.log      the translate log
#   metrics.json     the readability metrics measured on the freshly-translated
#                    tree, as the pre-validation baseline for the gate job
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=build/selfmig-common.sh
source "$repo_root/build/selfmig-common.sh"
work_root=${SELFMIG_GATE_ROOT:-"${TMPDIR:-/tmp}/gsharp-cs2gs-selfmig"}

case "$work_root" in
  ""|"/"|"$repo_root")
    echo "Refusing unsafe self-migration gate root: '$work_root'" >&2
    exit 2
    ;;
esac

rm -rf "$work_root"
mkdir -p "$work_root"
work_root=$(cd "$work_root" && pwd -P)
migrated_dir="$work_root/migrated"
runs_dir="$work_root/runs"

selfmig_build_prerequisites

set +e
dotnet "$repo_root/out/bin/Release/Cs2Gs.Cli/cs2gs.dll" migrate \
  --corpus "$repo_root" \
  --out "$migrated_dir" \
  --artifacts "$runs_dir" \
  --config Release \
  --translate-only \
  "${selfmig_excludes[@]}" \
  | tee "$work_root/migrate.log"
migrate_exit=${PIPESTATUS[0]}
set -e

run_json=$(find "$runs_dir" -maxdepth 2 -name run.json | sort | tail -1)
if [[ -z "$run_json" ]]; then
  echo "self-migration gate: no run.json produced (migrate exit $migrate_exit)." >&2
  exit 1
fi

run_dir=$(dirname "$run_json")
echo "$run_dir" > "$work_root/migrate-run-dir.txt"

# The metrics are measured here, on the just-translated tree, because that is
# the tree the shards start from. Stage 2's `!!` polish pass then rewrites some
# files in each shard's own copy; the shards ship those rewrites back as a
# small delta and the gate job replays them before re-measuring, so the final
# numbers match a single whole run.
selfmig_measure "$migrated_dir"
jq -n \
  --argjson labels "$labels" \
  --argjson lifts "$lifts" \
  --argjson longLines "$long_lines" \
  --argjson bangs "$bangs" \
  '{labels: $labels, lifts: $lifts, longLines: $longLines, bangs: $bangs}' \
  > "$work_root/metrics.json"

translated=$(jq '[.apps[] | select(.succeeded)] | length' "$run_json")
total=$(jq '.apps | length' "$run_json")
echo "self-migration translate: $translated/$total apps translated (migrate exit $migrate_exit)."
echo "pre-validation metrics: labels=$labels __local_=$lifts lines>300=$long_lines bangs=$bangs"
