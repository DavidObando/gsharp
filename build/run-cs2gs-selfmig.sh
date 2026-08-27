#!/usr/bin/env bash
# Issue #3501 Track C: the repo self-migration gate. Migrates the ENTIRE
# GSharp repository from C# to G# (translate + compile + ilverify + parity
# per project) and enforces the ratcheting baseline in
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
# E2E fixtures that are not migration targets are excluded via --exclude.
# The two net472 VS-extension apps (VsGsharp, VsGsharp.CodeLens) are excluded
# by policy: they build only under the Windows-only VSSDK toolchain (VSCT
# compile, pkgdef), so the Linux gate cannot even load them (no net472
# targeting pack) and a migrated G# build has no toolchain to run against.
# VsGsharp.UnitTests (net10.0) stays in the corpus.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
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

set +e
dotnet "$repo_root/out/bin/Release/Cs2Gs.Cli/cs2gs.dll" migrate \
  --corpus "$repo_root" \
  --out "$migrated_dir" \
  --artifacts "$runs_dir" \
  --config Release \
  --exclude samples/ProjectRef/CSharpApp \
  --exclude samples/PropertyRef/CSharpApp \
  --exclude src/vs-gsharp/src/VsGsharp/VsGsharp.csproj \
  --exclude src/vs-gsharp/src/VsGsharp.CodeLens/VsGsharp.CodeLens.csproj \
  --exclude tools/cs2gs/corpus/CompileGap-Library \
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

# Metrics count CODE, not fixtures: migrated test sources embed expected-output
# strings (and docs quote constructs), so lines containing a string quote or
# leading with a comment marker are excluded before counting.
code_grep() {
  # A ZERO-match metric is success, not failure: without the || true, the
  # no-match grep's exit 1 kills the script under `set -eo pipefail` before
  # the ceilings are ever checked (exactly what happened once the synthetic
  # label count reached 0).
  local count
  count=$(grep -rhE "$1" "$migrated_dir" --include='*.gs' 2>/dev/null \
    | grep -v '"' | grep -vE '^[[:space:]]*//' | grep -oE "$1" | wc -l | tr -d ' ') || true
  echo "${count:-0}"
}
labels=$(code_grep '__(switchExit|iteratorExit|gotoCase|gotoDefault|patternGuardEnd)')
lifts=$(code_grep '__local_')
long_lines=$(find "$migrated_dir" -name '*.gs' -exec awk 'length($0)>300' {} + 2>/dev/null | wc -l | tr -d ' ')
bangs=$(code_grep '!!')

green_floor=$(jq -r '.greenFloor' "$baseline")
label_ceiling=$(jq -r '.syntheticLabelCeiling' "$baseline")
lift_ceiling=$(jq -r '.liftedLocalCeiling' "$baseline")
long_ceiling=$(jq -r '.longLineCeiling' "$baseline")
bang_ceiling=$(jq -r '.nullAssertionCeiling' "$baseline")

summary="self-migration: $green/$total green (floor $green_floor); labels=$labels (ceiling $label_ceiling); __local_=$lifts (ceiling $lift_ceiling); lines>300=$long_lines (ceiling $long_ceiling); bangs=$bangs (ceiling $bang_ceiling)"
echo "$summary"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### cs2gs self-migration gate"
    echo ''
    echo "| metric | value | baseline |"
    echo "|---|---|---|"
    echo "| green apps | $green/$total | floor $green_floor |"
    echo "| synthetic labels | $labels | ceiling $label_ceiling |"
    echo "| \`__local_\` lifts | $lifts | ceiling $lift_ceiling |"
    echo "| lines >300 chars | $long_lines | ceiling $long_ceiling |"
    echo "| \`!!\` assertions | $bangs | ceiling $bang_ceiling |"
  } >> "$GITHUB_STEP_SUMMARY"
fi

status=0
if (( green < green_floor )); then
  echo "GATE: green count $green fell below floor $green_floor." >&2
  status=1
fi
if (( labels > label_ceiling )); then
  echo "GATE: synthetic label count $labels exceeded ceiling $label_ceiling." >&2
  status=1
fi
if (( lifts > lift_ceiling )); then
  echo "GATE: __local_ count $lifts exceeded ceiling $lift_ceiling." >&2
  status=1
fi
if (( long_lines > long_ceiling )); then
  echo "GATE: >300-char line count $long_lines exceeded ceiling $long_ceiling." >&2
  status=1
fi
if (( bangs > bang_ceiling )); then
  echo "GATE: !! null-assertion count $bangs exceeded ceiling $bang_ceiling." >&2
  status=1
fi

if (( status == 0 )); then
  echo "Self-migration gate PASSED."
fi
exit "$status"
