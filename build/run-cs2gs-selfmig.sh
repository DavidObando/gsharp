#!/usr/bin/env bash
# Issue #3501 Track C: the repo self-migration gate, CLASSIC SINGLE-JOB path.
# Migrates the ENTIRE GSharp repository from C# to G# (translate + compile +
# ilverify + parity per project) and enforces the ratcheting baseline in
# tools/cs2gs/selfmig-baseline.json:
#
#   - greenFloor:            minimum fully-green apps (run fails below it)
#   - greenApps:             identities that must remain fully green
#   - stageFloor:            furthest attempted stage for each red app
#   - syntheticLabelCeiling: max __switchExit/__iteratorExit/__gotoCase/
#                            __patternGuardEnd occurrences in migrated output
#   - liftedLocalCeiling:    max __local_ lifted-helper occurrences
#   - longLineCeiling:       max formatter-reducible raw lines over 300 chars
#   - nullAssertionCeiling:  max !! null-assertion occurrences
#
# The ceilings cap readability regressions; the floor caps functional ones.
# When a Track A/B improvement lands, tighten the corresponding number in the
# baseline within the same PR so progress ratchets.
#
# Issue #3668: the NIGHTLY runs the sharded pipeline instead
# (run-cs2gs-selfmig-migrate.sh + run-cs2gs-selfmig-validate.sh +
# run-cs2gs-selfmig-gate.sh), which is the same work split across runners.
# This script stays the reference implementation and the local proof path: it
# is what the sharded pipeline is verified to be equivalent to.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=build/selfmig-common.sh
source "$repo_root/build/selfmig-common.sh"
baseline="$repo_root/tools/cs2gs/selfmig-baseline.json"
work_root=${SELFMIG_GATE_ROOT:-"${TMPDIR:-/tmp}/gsharp-cs2gs-selfmig"}

case "$work_root" in
  ""|"/"|"$repo_root"|"$selfmig_source_root")
    echo "Refusing unsafe self-migration gate root: '$work_root'" >&2
    exit 2
    ;;
esac

# Issue #4919: a SEPARATE corpus (SELFMIG_SOURCE_ROOT) needs the migrated
# mirror prepared between translation and validation: the corpus's own
# Gsharp.NET.Sdk package staged in its local feed (selfmig_stage_corpus_sdk;
# the mirror must be empty when `migrate` creates it, so it cannot be staged
# beforehand) and the corpus runtime under the pinned SDK
# (selfmig_with_corpus_runtime). One `migrate` invocation runs both phases, so
# this path runs the sharded pipeline on this one machine instead -- translate,
# ONE validate shard holding every translated app, gate -- which is the same
# work, prepared the same way the nightly prepares it.
if [[ "$selfmig_source_root" != "$selfmig_default_root" ]]; then
  export SELFMIG_GATE_ROOT="$work_root"
  "$repo_root/build/run-cs2gs-selfmig-migrate.sh"
  work_root=$(cd "$work_root" && pwd -P)
  manifest_run_json="$(cat "$work_root/migrate-run-dir.txt")/run.json"
  translated_apps=()
  while IFS= read -r app; do
    translated_apps+=("$app")
  done < <(jq -r '.apps[] | select(any(.stages[]?; .stage == "translate" and .status == "passed")) | .appId' "$manifest_run_json")
  if (( ${#translated_apps[@]} > 0 )); then
    "$repo_root/build/run-cs2gs-selfmig-validate.sh" local "${translated_apps[@]}"
  fi
  mkdir -p "$work_root/shards"
  if [[ -d "$work_root/shard-local" ]]; then
    mv "$work_root/shard-local" "$work_root/shards/local"
  fi
  exec "$repo_root/build/run-cs2gs-selfmig-gate.sh" "$work_root" "$work_root/shards"
fi

rm -rf "$work_root"
mkdir -p "$work_root"
work_root=$(cd "$work_root" && pwd -P)
migrated_dir="$work_root/migrated"
runs_dir="$work_root/runs"

selfmig_build_prerequisites

# Issue #4633: list every C# test project's cases first; this single-job path
# runs test parity inside the same `migrate` invocation, so the oracle must
# already exist. (The sharded gate captures after translation instead.) A
# capture failure only fails the affected apps, as TEST-ORACLE-MISSING.
dotnet "$repo_root/out/bin/Release/Cs2Gs.Cli/cs2gs.dll" capture-test-oracle \
  --corpus "$selfmig_source_root" \
  --out "$work_root/csharp-tests" \
  "${selfmig_project_filters[@]}" \
  || echo "self-migration gate: capturing the C# test oracle failed for some test project(s)." >&2

set +e
dotnet "$repo_root/out/bin/Release/Cs2Gs.Cli/cs2gs.dll" migrate \
  --corpus "$selfmig_source_root" \
  --sdk-pin global-json \
  --out "$migrated_dir" \
  --artifacts "$runs_dir" \
  --config Release \
  --csharp-test-oracle "$work_root/csharp-tests" \
  "${selfmig_project_filters[@]}" \
  | tee "$work_root/migrate.log"
migrate_exit=${PIPESTATUS[0]}
set -e

run_json=$(find "$runs_dir" -maxdepth 2 -name run.json | sort | tail -1)
if [[ -z "$run_json" ]]; then
  echo "self-migration gate: no run.json produced (migrate exit $migrate_exit)." >&2
  exit 1
fi

green=$(jq '[.apps[] | select(.succeeded)] | length' "$run_json")
total=$(jq '.apps | length' "$run_json")

# Issue #4856: the leg's stats.json, as the sharded gate writes it.
trap 'selfmig_write_stats "$run_json" "$baseline" "$work_root/stats.json" "$?"' EXIT

selfmig_measure "$migrated_dir"
selfmig_apply_baseline "$baseline" "$green" "$total" "$run_json"
