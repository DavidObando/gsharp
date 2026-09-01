#!/usr/bin/env bash
# Issue #3501 Track C: the repo self-migration gate, CLASSIC SINGLE-JOB path.
# Migrates the ENTIRE GSharp repository from C# to G# (translate + compile +
# ilverify + parity per project) and enforces the ratcheting baseline in
# tools/cs2gs/selfmig-baseline.json:
#
#   - greenFloor:            minimum fully-green apps (run fails below it)
#   - syntheticLabelCeiling: max __switchExit/__iteratorExit/__gotoCase/
#                            __patternGuardEnd occurrences in migrated output
#   - liftedLocalCeiling:    max __local_ lifted-helper occurrences
#   - longLineCeiling:       max lines longer than 300 characters
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
  "${selfmig_excludes[@]}" \
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

selfmig_measure "$migrated_dir"
selfmig_apply_baseline "$baseline" "$green" "$total" "$run_json"
