#!/usr/bin/env bash
# Issue #3501 Track C / issue #3668: the pieces of the repo self-migration gate
# that BOTH the classic single-job path (build/run-cs2gs-selfmig.sh) and the
# sharded path (run-cs2gs-selfmig-{migrate,validate,gate}.sh) must agree on:
#
#   - the --exclude set (it defines the DISCOVERED app set, so every stage of
#     the sharded pipeline has to pass the identical list; see below),
#   - the readability metric definitions,
#   - the baseline threshold evaluation and its output format.
#
# Sourced, never executed. Callers set `repo_root` before sourcing.

# E2E fixtures that are not migration targets are excluded via --exclude.
# The Visual Studio extension stays in C# by decision (like the VSCode
# extension stays in TypeScript), so all three vs-gsharp apps are excluded:
# VsGsharp and VsGsharp.CodeLens build only under the Windows-only VSSDK
# toolchain (VSCT compile, pkgdef), and VsGsharp.UnitTests tests the
# permanently-C# extension via linked sources. Gsharp.Extensions is excluded
# because it is ALREADY G# (all-.gs sources bootstrapped by the latest
# compiler without a gsproj) — there is nothing to migrate, and feeding its
# .gs sources through the C# parser only produces phantom gaps.
#
# INVARIANT (issue #3668): --exclude is NOT a sharding mechanism. Excluding a
# project that another app project-references breaks reference resolution and
# manufactures phantom cascades (dropping src/Core from a LanguageServer run
# yielded ~794 bogus errors). Every job in the sharded pipeline therefore
# passes this exact list; shards are selected with `cs2gs validate --shard`,
# which narrows what is EXECUTED, never what is discovered.
selfmig_excludes=(
  --exclude samples/ProjectRef/CSharpApp
  --exclude samples/PropertyRef/CSharpApp
  --exclude src/vs-gsharp/src/VsGsharp/VsGsharp.csproj
  --exclude src/vs-gsharp/src/VsGsharp.CodeLens/VsGsharp.CodeLens.csproj
  --exclude src/vs-gsharp/test/VsGsharp.UnitTests
  --exclude src/Sdk/Gsharp.Extensions
  --exclude tools/cs2gs/corpus/CompileGap-Library
)

# MSBuildWorkspace design-time project loads evaluate in Debug regardless of
# --config Release, and Gsharp.Extensions.csproj's Bootstrap SDK import
# hard-errors when out/bin/Debug/{Compiler/gsc.dll, Gsharp.NET.Sdk/
# Gsharp.NET.Sdk.dll} are missing — which fails ProjectLoad (CS2GS0001) for
# every app that transitively references Gsharp.Extensions (Repl, the
# Compiler/Extensions/Interpreter test projects, ...). Build both Debug
# prerequisites up front; the Compiler must come first because the SDK build
# compiles Gsharp.Extensions' .gs sources with the bootstrap gsc.
selfmig_build_prerequisites() {
  dotnet build "$repo_root/src/Compiler/Compiler.csproj" -c Debug -graph
  dotnet build "$repo_root/src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.csproj" -c Debug -graph
}

# Metrics count CODE, not fixtures: migrated test sources embed expected-output
# strings (and docs quote constructs), so lines containing a string quote or
# leading with a comment marker are excluded before counting.
selfmig_code_grep() {
  local migrated_dir=$1 pattern=$2
  # A ZERO-match metric is success, not failure: without the || true, the
  # no-match grep's exit 1 kills the script under `set -eo pipefail` before
  # the ceilings are ever checked (exactly what happened once the synthetic
  # label count reached 0).
  local count
  count=$(grep -rhE "$pattern" "$migrated_dir" --include='*.gs' 2>/dev/null \
    | grep -v '"' | grep -vE '^[[:space:]]*//' | grep -oE "$pattern" | wc -l | tr -d ' ') || true
  echo "${count:-0}"
}

# Hashes every .gs file in a migrated tree as "<hash>  <tree-relative path>",
# sorted by path. Used by the shards to ship stage 2's `!!` polish rewrites
# back to the gate job as a delta, so the gate re-measures the same tree a
# single whole run would have produced.
selfmig_hash_tree() {
  local tree=$1 hasher
  # sha256sum on Linux runners, shasum -a 256 on macOS; both print
  # "<hash>  <path>".
  if command -v sha256sum >/dev/null 2>&1; then
    hasher=(sha256sum)
  else
    hasher=(shasum -a 256)
  fi
  ( cd "$tree" && find . -name '*.gs' -type f -print0 \
      | xargs -0 -n 200 "${hasher[@]}" | sort -k2 )
}

# Computes the four readability metrics over a migrated tree, into the caller's
# `labels`, `lifts`, `long_lines` and `bangs` variables.
selfmig_measure() {
  local migrated_dir=$1
  labels=$(selfmig_code_grep "$migrated_dir" '__(switchExit|iteratorExit|gotoCase|gotoDefault|patternGuardEnd)')
  lifts=$(selfmig_code_grep "$migrated_dir" '__local_')
  long_lines=$(find "$migrated_dir" -name '*.gs' -exec awk 'length($0)>300' {} + 2>/dev/null | wc -l | tr -d ' ')
  bangs=$(selfmig_code_grep "$migrated_dir" '!!')
}

# Applies the ratcheting baseline to a green count and the measured metrics,
# printing the canonical one-line summary, the step-summary table, and one
# `GATE: ...` line per breach. Returns 1 when any threshold is breached.
#
# The output format is a contract: humans and tooling parse these exact lines.
selfmig_apply_baseline() {
  local baseline=$1 green=$2 total=$3 run_json=${4:-}

  local green_floor label_ceiling lift_ceiling long_ceiling bang_ceiling
  green_floor=$(jq -r '.greenFloor' "$baseline")
  label_ceiling=$(jq -r '.syntheticLabelCeiling' "$baseline")
  lift_ceiling=$(jq -r '.liftedLocalCeiling' "$baseline")
  long_ceiling=$(jq -r '.longLineCeiling' "$baseline")
  bang_ceiling=$(jq -r '.nullAssertionCeiling' "$baseline")

  local summary
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

  local status=0
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

  # Issue #3764: the COUNT is not the composition. src/Sdk/Gsharp.NET.Sdk
  # regressed green -> ilverify-failure in run 33463929797 while the headline
  # stayed 41/51, because src/Repl went green in the same range and paid for
  # it. A silently-emitted-bad-IL regression therefore reached main with a
  # passing gate. `greenApps` pins the identities: every app listed there must
  # still be green, whatever the total says.
  #
  # The list is a ratchet like the ceilings — when an app goes green, add it in
  # the same PR. If an app in it proves genuinely flaky (test-parity stages can
  # be), remove it with a note rather than leaving the gate red.
  if [[ -n "$run_json" && -f "$run_json" ]]; then
    local expected_green regressed newly
    expected_green=$(jq -r '(.greenApps // []) | length' "$baseline")
    if (( expected_green > 0 )); then
      regressed=$(jq -r --slurpfile baselineDoc "$baseline" \
        '[.apps[] | select(.succeeded) | .appId] as $green
         | (($baselineDoc[0].greenApps // []) - $green) | .[]' "$run_json")
      newly=$(jq -r --slurpfile baselineDoc "$baseline" \
        '[.apps[] | select(.succeeded) | .appId] as $green
         | ($green - ($baselineDoc[0].greenApps // [])) | .[]' "$run_json")

      if [[ -n "$newly" ]]; then
        echo "self-migration: newly green (add to greenApps to bank it):"
        echo "$newly" | sed 's/^/  + /'
      fi

      if [[ -n "$regressed" ]]; then
        echo "GATE: app(s) listed in greenApps are no longer green:" >&2
        echo "$regressed" | sed 's/^/  - /' >&2
        status=1
      fi
    fi
  fi

  if (( status == 0 )); then
    echo "Self-migration gate PASSED."
  fi
  return "$status"
}
