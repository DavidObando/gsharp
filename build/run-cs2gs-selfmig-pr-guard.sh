#!/usr/bin/env bash
# Issue #3836: the PR-time translation guard for the self-migration effort
# (#3501).
#
# THE HAZARD THIS EXISTS FOR
#
# CI *compiles* the repository's C# sources. The self-migration gate
# *translates* them to G# and then compiles the result. Those are different
# questions, and a source file can answer the first perfectly while failing
# the second — so a fully CI-green PR can take the nightly gate down purely by
# existing, and the damage surfaces hours later attributed to whatever else
# landed nearby. It has happened three times:
#
#   #3831  a new tools/cs2gs/Cs2Gs.Translator file did not translate;
#          7 banked apps red, gate 43 -> 35.
#   #3896  three untranslatable errors in #3882's new src/Core files;
#          16 apps red, gate 44 -> 28.
#   #3905  #3882's src/Sdk/Gsharp.Runtime.Channels crashed gsc with a stack
#          overflow, blinding 11 apps behind "no parseable diagnostics".
#
# All three are the same shape: a *hot-core* project — one that most of the
# corpus transitively references — stopped surviving its own migration, and
# the cost was paid by everything downstream. This script migrates exactly
# that hot core and nothing else, so the same failures are minutes of PR time
# instead of a night of gate time.
#
# WHAT IT COVERS, AND WHAT IT DOES NOT
#
# It migrates the apps in $guard_apps below — Cs2Gs.Translator's reference
# closure, which is #3836's recommendation — and runs translate -> compile ->
# ilverify -> test-parity for those apps only.
#
# It is NOT the gate. It says nothing about the other ~49 apps, about the
# readability ceilings, or about test parity across the corpus. A green run
# here means "the hot core still migrates", never "this PR migrates fine".
# The banner printed at the end says so out loud on purpose.
#
# In particular it does NOT cover src/Sdk/Gsharp.Runtime.Channels, i.e. it
# would NOT have caught #3905 — see the note under guard_apps.
#
# Usage: run-cs2gs-selfmig-pr-guard.sh
# Environment:
#   SELFMIG_PR_GUARD_ROOT  work root (default ${TMPDIR:-/tmp}/gsharp-cs2gs-pr-guard)
#   SELFMIG_PR_GUARD_APPS  space-separated override for the app list, so the
#                          set can be widened (e.g. to tools/cs2gs/Cs2Gs.Tests
#                          once #3836's ~9 known failures clear) without
#                          editing this file.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# The guarded hot core, as repository-relative .csproj paths (which is exactly
# what cs2gs uses as an app id).
#
# INVARIANT: this list must be CLOSED under ProjectReference. `--exclude` on a
# project that a KEPT app references breaks reference resolution in the
# migrated tree and manufactures phantom cascades — dropping src/Core from a
# LanguageServer run once produced ~794 bogus errors. verify_closure() below
# fails the run rather than let that happen silently.
#
#   src/Core                      the dependency root of most of the corpus,
#                                 and #3896's blast radius.
#   src/Analyzers/InternalAnalyzers  Core's analyzer ProjectReference.
#   tools/cs2gs/Cs2Gs.CodeModel   Core -> CodeModel -> Translator, the chain
#                                 #3836 names.
#   tools/cs2gs/Cs2Gs.Translator  cs2gs is inside its own corpus (#3831).
#
# DELIBERATELY ABSENT, and the first thing to add back:
#
#   src/Sdk/Gsharp.Runtime.Channels — #3905's root, referenced by eight
#   projects, and a ProjectReference leaf, so it would cost this job about
#   four minutes and would make the guard cover all three incidents instead
#   of two. It is left out only because it is RED ON MAIN TODAY (#3907: the
#   #3905 crash fix un-blinded 327 diagnostics), and a guard that is red from
#   day one gets ignored or disabled. Measured on 03b6e1e8d, adding it gives
#   4/5 rather than 5/5 — a real failure, not a harness artifact, which is
#   itself evidence this job detects the thing it is for. Add the line back
#   the moment #3907 closes; nothing else needs to change.
#
# The same reasoning governs tools/cs2gs/Cs2Gs.Tests, which #3836 names as the
# natural second step: it has ~9 known migration failures and would be red by
# construction until those clear.
guard_apps=(
  src/Analyzers/InternalAnalyzers/InternalAnalyzers.csproj
  src/Core/Core.csproj
  tools/cs2gs/Cs2Gs.CodeModel/Cs2Gs.CodeModel.csproj
  tools/cs2gs/Cs2Gs.Translator/Cs2Gs.Translator.csproj
)

if [[ -n "${SELFMIG_PR_GUARD_APPS:-}" ]]; then
  # shellcheck disable=SC2206
  guard_apps=(${SELFMIG_PR_GUARD_APPS})
fi

work_root=${SELFMIG_PR_GUARD_ROOT:-"${TMPDIR:-/tmp}/gsharp-cs2gs-pr-guard"}
case "$work_root" in
  ""|"/"|"$repo_root")
    echo "Refusing unsafe PR-guard root: '$work_root'" >&2
    exit 2
    ;;
esac

# Fails the run when a guarded app project-references something outside the
# guarded set, i.e. when the set stopped being closed under ProjectReference.
# The check is textual on purpose: it needs no MSBuild evaluation, so it runs
# before anything expensive.
verify_closure() {
  local app dir ref resolved missing=0
  for app in "${guard_apps[@]}"; do
    dir=$(dirname "$repo_root/$app")
    while IFS= read -r ref; do
      # Windows-style separators in the .csproj, POSIX path on disk.
      ref=${ref//\\//}
      resolved=$(cd "$dir" && cd "$(dirname "$ref")" 2>/dev/null && pwd -P)/$(basename "$ref")
      resolved=${resolved#"$repo_root/"}
      if [[ ! " ${guard_apps[*]} " == *" $resolved "* ]]; then
        echo "PR guard: '$app' references '$resolved', which is not in the guarded set." >&2
        missing=1
      fi
    done < <(grep -o 'ProjectReference Include="[^"]*"' "$repo_root/$app" 2>/dev/null \
      | sed 's/.*Include="//; s/"$//')
  done
  if (( missing )); then
    echo "PR guard: the guarded app set is no longer closed under ProjectReference." >&2
    echo "Add the referenced project(s) to guard_apps — excluding them would" >&2
    echo "manufacture phantom cascades rather than report real ones." >&2
    exit 2
  fi
}

verify_closure

# Everything that is not guarded is excluded. Because the guarded set is
# closed under ProjectReference (verified above), no kept app references an
# excluded one, so this narrowing cannot manufacture the phantom cascades the
# gate's --exclude invariant warns about.
excludes=()
while IFS= read -r project; do
  if [[ ! " ${guard_apps[*]} " == *" $project "* ]]; then
    excludes+=(--exclude "$project")
  fi
done < <(cd "$repo_root" && git ls-files '*.csproj' | sort)

# A short list would mean the enumeration silently failed, and a migrate with
# too few --excludes would quietly migrate the whole repository instead of the
# hot core — a 30-minute job pretending to be a 20-minute one.
if (( ${#excludes[@]} < 80 )); then
  echo "PR guard: enumerated only $(( ${#excludes[@]} / 2 )) project(s) to exclude; the" >&2
  echo "repository has ~60. Is this a git checkout?" >&2
  exit 2
fi

rm -rf "$work_root"
mkdir -p "$work_root"
work_root=$(cd "$work_root" && pwd -P)

# ORDER MATTERS, and this is the one part of the script that is fragile.
#
# The compile stage builds the migrated tree through the PACKED
# Gsharp.NET.Sdk nupkg under out/bin/Release/nupkgs. A freshly built gsc.dll
# alone is therefore silently ignored, and the run measures the OLD compiler —
# which for a guard would be worse than useless. The Release Gsharp.NET.Sdk
# build below repacks it, and it is the LAST thing built before migrate on
# purpose: repack strictly before migrate with nothing built in between is the
# ordering that avoids MSB4236 ("SDK not found") here.
#
# The three builds, in order:
#   1. the migration tool itself, in Release;
#   2. the Debug prerequisites — MSBuildWorkspace evaluates project loads in
#      Debug regardless of --config Release, and Gsharp.Extensions.csproj's
#      Bootstrap SDK import hard-errors when the Debug compiler/SDK outputs are
#      missing, which fails ProjectLoad for the whole run;
#   3. the Release SDK pack, immediately before migrate.
#
# Building GSharp.sln instead of these three also works and is what a local
# proof usually does, but it compiles every test project for nothing and adds
# roughly ten minutes to a job whose whole value is being fast.
dotnet build "$repo_root/tools/cs2gs/Cs2Gs.Cli/Cs2Gs.Cli.csproj" -c Release -graph
dotnet build "$repo_root/src/Compiler/Compiler.csproj" -c Debug -graph
dotnet build "$repo_root/src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.csproj" -c Debug -graph
echo "PR guard: repacking the Release Gsharp.NET.Sdk nupkg (the compile stage consumes it)."
dotnet build "$repo_root/src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.csproj" -c Release -graph

started=$(date +%s)

set +e
dotnet "$repo_root/out/bin/Release/Cs2Gs.Cli/cs2gs.dll" migrate \
  --corpus "$repo_root" \
  --out "$work_root/migrated" \
  --artifacts "$work_root/runs" \
  --config Release \
  "${excludes[@]}" \
  | tee "$work_root/guard.log"
migrate_exit=${PIPESTATUS[0]}
set -e

elapsed=$(( $(date +%s) - started ))

run_json=$(find "$work_root/runs" -maxdepth 2 -name run.json | sort | tail -1)
if [[ -z "$run_json" ]]; then
  echo "PR guard: no run.json produced (migrate exit $migrate_exit)." >&2
  exit 1
fi

green=$(jq '[.apps[] | select(.succeeded)] | length' "$run_json")
total=$(jq '.apps | length' "$run_json")
failed=$(jq -r '.apps[] | select(.succeeded | not) | .appId' "$run_json")

echo
echo "PR guard: $green/$total guarded app(s) migrated and compiled in ${elapsed}s (migrate exit $migrate_exit)."

# The scope disclaimer is emitted on EVERY run, pass or fail. A partial check
# that reads as a full one is worse than no check: the failure mode of #3831,
# #3896 and #3905 was precisely someone concluding "CI is green, so this is
# fine".
guard_app_lines=$(printf '    - %s\n' "${guard_apps[@]}")
scope_note="SCOPE — what a green run here does and does not mean.

  It means: the ${#guard_apps[@]} hot-core project(s) below still translate to G# and
  compile. Those are the projects whose migration failures have cascaded
  widest (#3831, #3896, #3905).

$guard_app_lines

  It does NOT mean this PR migrates cleanly. The self-migration gate covers
  ~53 apps, four readability ceilings and corpus-wide test parity; this job
  covers none of that. Only the nightly cs2gs-selfmig gate is the gate."
echo
echo "$scope_note"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### cs2gs PR translation guard (#3836)"
    echo
    echo "\`$green/$total\` guarded app(s) migrated + compiled in ${elapsed}s."
    echo
    if [[ -n "$failed" ]]; then
      echo "**Failed:**"
      echo "$failed" | sed 's/^/- `/; s/$/`/'
      echo
    fi
    echo '```'
    echo "$scope_note"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi

if [[ -n "$failed" ]]; then
  echo >&2
  echo "PR guard FAILED: the following guarded app(s) did not survive migration:" >&2
  echo "$failed" | sed 's/^/  - /' >&2
  echo >&2
  echo "This is the #3831/#3896/#3905 hazard: the C# compiles, the migrated G#" >&2
  echo "does not. See $work_root/guard.log and the uploaded run artifacts for the" >&2
  echo "diagnostics, and fix the source shape rather than the baseline." >&2
  exit 1
fi

echo "PR guard PASSED."
