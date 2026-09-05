#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# Issue #3501: the same readability counters the self-migration reports, so the
# three corpora are comparable at a glance. Counts only — code-exploder has no
# ratcheting baseline and deliberately gets no ceilings here.
# shellcheck source=build/cs2gs-counters.sh
source "$repo_root/build/cs2gs-counters.sh"
manifest="$repo_root/tools/cs2gs/external/code-exploder.json"
label=${CODE_EXPLODER_GATE_LABEL:-pinned}
work_root=${CODE_EXPLODER_GATE_ROOT:-"${TMPDIR:-/tmp}/gsharp-cs2gs-code-exploder/$label"}
repository=$(jq -r '.repository' "$manifest")
pinned_commit=$(jq -r '.commit' "$manifest")
ref=${CODE_EXPLODER_REF:-$pinned_commit}

case "$work_root" in
  ""|"/"|"$repo_root")
    echo "Refusing unsafe code-exploder gate root: '$work_root'" >&2
    exit 2
    ;;
esac

rm -rf "$work_root"
mkdir -p "$work_root"
work_root=$(cd "$work_root" && pwd -P)
source_dir="$work_root/source"
migrated_dir="$work_root/migrated"
runs_dir="$work_root/runs"
log_file="$work_root/migrate.log"

git init --quiet "$source_dir"
git -C "$source_dir" remote add origin "$repository"
git -C "$source_dir" fetch --quiet origin "$ref"
git -C "$source_dir" checkout --quiet --detach FETCH_HEAD
actual_commit=$(git -C "$source_dir" rev-parse HEAD)

# Keep MSBuild from importing Directory.Build.* files above the isolated clone
# when CODE_EXPLODER_GATE_ROOT is placed under this repository.
[[ -e "$source_dir/Directory.Build.props" ]] || printf '<Project />\n' > "$source_dir/Directory.Build.props"
[[ -e "$source_dir/Directory.Build.targets" ]] || printf '<Project />\n' > "$source_dir/Directory.Build.targets"

if [[ "$ref" == "$pinned_commit" && "$actual_commit" != "$pinned_commit" ]]; then
  echo "Expected pinned code-exploder commit $pinned_commit, got $actual_commit." >&2
  exit 1
fi

export NUGET_PACKAGES="$work_root/nuget-packages"
# The pinned Testcontainers dependency currently carries a test-only SSH.NET
# advisory. Keep the compatibility gate runnable until the corpus updates;
# production dependency auditing remains enabled in both repositories' own CI.
export NuGetAudit=false

echo "code-exploder gate '$label': $actual_commit"

dotnet restore "$source_dir/codeexploder.slnx"
dotnet build "$source_dir/codeexploder.slnx" --configuration Release --no-restore
dotnet test "$source_dir/codeexploder.slnx" \
  --configuration Release --no-build --no-restore

set +e
dotnet "$repo_root/out/bin/Release/Cs2Gs.Cli/cs2gs.dll" migrate \
  --corpus "$source_dir" \
  --out "$migrated_dir" \
  --artifacts "$runs_dir" \
  --config Release | tee "$log_file"
migrate_exit=${PIPESTATUS[0]}
set -e

# Before the exit check: a failed migration still produced whatever it emitted,
# and the counters over a partial tree are more useful than none.
cs2gs_emit_counter_report "$migrated_dir" 'cs2gs code-exploder: readability counters' \
  'Counts only — code-exploder has no ratcheting baseline, so nothing here gates the job.' || true

if (( migrate_exit != 0 )); then
  exit "$migrate_exit"
fi

echo "code-exploder C# and 17-project migrated G# validation passed."
