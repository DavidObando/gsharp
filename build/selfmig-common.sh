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

# Issue #3501: the counter definitions themselves are shared with the OTHER two
# corpora (Oahu, code-exploder) so all three report the same table. Only the
# ceilings below are specific to the self-migration.
# shellcheck source=build/cs2gs-counters.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cs2gs-counters.sh"

# E2E fixtures that are not migration targets are excluded via --exclude.
# The Visual Studio extension stays in C# by decision (like the VSCode
# extension stays in TypeScript), so all three vs-gsharp apps are excluded:
# VsGsharp and VsGsharp.CodeLens build only under the Windows-only VSSDK
# toolchain (VSCT compile, pkgdef), and VsGsharp.UnitTests tests the
# permanently-C# extension via linked sources. Gsharp.Extensions is excluded
# because it is ALREADY G# (all-.gs sources bootstrapped by the latest
# compiler without a gsproj) — there is nothing to migrate, and feeding its
# .gs sources through the C# parser only produces phantom gaps. Excluded from
# TRANSLATION is not excluded from the MIRROR: issue #3772 keeps its .csproj in
# the migrated tree (with references retargeted), because its .gs sources are
# mirrored verbatim and four migrated projects — Extensions.Tests,
# Compiler.Tests, Interpreter.Tests and Repl — project-reference it.
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
  # ADR-0174 D11: the concurrency benchmark's C# and Go sides are measurement
  # apparatus, not migration targets. Translating the CLR baseline would
  # measure the translator rather than the runtime, which is the one thing this
  # harness must not do. The AOT project holds no logic at all — its only C# is
  # a placeholder Main that the publish overwrites.
  --exclude bench/concurrency/clr
  --exclude bench/concurrency/aot
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
#
# The line filter now lives in build/cs2gs-counters.sh (cs2gs_code_lines) so the
# three corpora measure identically; the counting semantics here are UNCHANGED,
# and deliberately so. The quote exclusion undercounts (#3937: a removed `!!` on
# a line reading `Arguments: []object{uri!!, ...}` was invisible to the metric),
# but every ceiling in tools/cs2gs/selfmig-baseline.json was measured through
# it, so "fixing" it would silently move all of them. The gated numbers keep the
# old behaviour; the raw counts are reported alongside in the counter table.
selfmig_code_grep() {
  local migrated_dir=$1 pattern=$2
  # A ZERO-match metric is success, not failure: without the || true, the
  # no-match grep's exit 1 kills the script under `set -eo pipefail` before
  # the ceilings are ever checked (exactly what happened once the synthetic
  # label count reached 0).
  local count
  count=$(cs2gs_code_lines "$migrated_dir" | cs2gs_count_stream "$pattern") || true
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
#
# Issue #3895: `bangs` is a function of the TREE, and a tree has two distinct
# states in this pipeline. The migrate job measures the freshly-TRANSLATED tree;
# the gate job measures it again after the validate shards' `!!` polish deltas
# are replayed, and the polish strips whatever gsc reported as GS0536, so a gsc
# change moves the second number without moving the first. The two numbers are
# therefore NOT comparable with each other — only migrate-vs-migrate or
# gate-vs-gate is. A `!!`-only diff across many otherwise-unrelated files is the
# signature of comparing across that boundary, not of a nondeterministic
# translator: five whole-repository `migrate --translate-only` passes over one
# commit produce byte-identical trees (measured on #3895).
selfmig_measure() {
  local migrated_dir=$1
  # Remembered so selfmig_apply_baseline can add the per-family synthetic
  # breakdown (#3501) to the job summary without changing its signature.
  selfmig_measured_tree=$migrated_dir
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
      echo ''
    } >> "$GITHUB_STEP_SUMMARY"
  fi

  # Issue #3501: the per-family synthetic-identifier breakdown, printed to the
  # log and appended to the job summary. It is ADDITIVE — the gated rows above
  # are untouched, and nothing below participates in the pass/fail decision.
  if [[ -n "${selfmig_measured_tree:-}" && -d "${selfmig_measured_tree:-}" ]]; then
    cs2gs_emit_counter_report "$selfmig_measured_tree" \
      'cs2gs self-migration: readability counters (gsharp)' || true
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

  # Issue #3885: the test-parity failure allow-list. An app whose mirrored test
  # failures are a SUBSET of its allow-list entries reports green — but the run
  # must never be silent about it, or the list becomes the dangerous kind. Both
  # halves are printed whatever the gate verdict:
  #
  #   * every allow-listed failure that actually occurred, so a green app that
  #     is green only because of the list still says which tests it excused;
  #   * every entry that did NOT fire in a completed run, i.e. the test now
  #     passes and the entry is stale.
  #
  # Staleness is ADVISORY, deliberately. It is reported exactly as loudly as
  # `greenApps` reports newly-green apps to bank, and like that report it does
  # not set `status`: making it fatal would turn the PR that FIXES a test red,
  # which is precisely the wrong incentive to build into a gate. The subset rule
  # itself is what stays hard.
  if [[ -n "$run_json" && -f "$run_json" ]]; then
    local allowed stale
    allowed=$(jq -r '[.apps[] | . as $app | (.allowedTestFailures // [])[]
      | $app.appId + ": " + .] | .[]' "$run_json")
    stale=$(jq -r '[.apps[] | . as $app | (.staleAllowListEntries // [])[]
      | $app.appId + ": " + .] | .[]' "$run_json")

    if [[ -n "$allowed" ]]; then
      echo "self-migration: allow-listed test-parity failures (#3885) — these did NOT fail the gate:"
      echo "$allowed" | sed 's/^/  ~ /'
    fi

    if [[ -n "$stale" ]]; then
      echo "self-migration: allow-list entries no longer failing — remove from the allow-list:"
      echo "$stale" | sed 's/^/  - /'
    fi
  fi

  if (( status == 0 )); then
    echo "Self-migration gate PASSED."
  fi
  return "$status"
}
