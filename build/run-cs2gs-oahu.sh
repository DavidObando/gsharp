#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
manifest="$repo_root/tools/cs2gs/external/oahu.json"
label=${OAHU_GATE_LABEL:-pinned}
work_root=${OAHU_GATE_ROOT:-"${TMPDIR:-/tmp}/gsharp-cs2gs-oahu/$label"}
repository=$(jq -r '.repository' "$manifest")
pinned_commit=$(jq -r '.commit' "$manifest")
ref=${OAHU_REF:-$pinned_commit}

case "$work_root" in
  ""|"/"|"$repo_root")
    echo "Refusing unsafe Oahu gate root: '$work_root'" >&2
    exit 2
    ;;
esac

rm -rf "$work_root"
mkdir -p "$work_root"
work_root=$(cd "$work_root" && pwd -P)
source_dir="$work_root/source"
migrated_dir="$work_root/migrated"
runs_dir="$work_root/runs"
smoke_dir="$work_root/smoke"
log_file="$work_root/migrate.log"

git init --quiet "$source_dir"
git -C "$source_dir" remote add origin "$repository"
git -C "$source_dir" fetch --quiet origin "$ref"
git -C "$source_dir" checkout --quiet --detach FETCH_HEAD
actual_commit=$(git -C "$source_dir" rev-parse HEAD)

# Keep MSBuild from importing Directory.Build.* files above the isolated clone
# when OAHU_GATE_ROOT is placed under this repository.
[[ -e "$source_dir/Directory.Build.props" ]] || printf '<Project />\n' > "$source_dir/Directory.Build.props"
[[ -e "$source_dir/Directory.Build.targets" ]] || printf '<Project />\n' > "$source_dir/Directory.Build.targets"

if [[ "$ref" == "$pinned_commit" && "$actual_commit" != "$pinned_commit" ]]; then
  echo "Expected pinned Oahu commit $pinned_commit, got $actual_commit." >&2
  exit 1
fi

echo "Oahu gate '$label': $actual_commit"

dotnet restore "$source_dir/Oahu.sln"
dotnet build "$source_dir/Oahu.sln" --configuration Release --no-restore
dotnet test "$source_dir/tests/Oahu.Cli.Tests/Oahu.Cli.Tests.csproj" \
  --configuration Release --no-build
dotnet test "$source_dir/tests/Oahu.Foundation.Tests/Oahu.Foundation.Tests.csproj" \
  --configuration Release --no-build
dotnet test "$source_dir/tests/Oahu.Cli.E2E.Tests/Oahu.Cli.E2E.Tests.csproj" \
  --configuration Release --no-build
dotnet "$source_dir/src/Oahu.App/bin/Release/net10.0/Oahu.dll" --smoke-test

set +e
dotnet "$repo_root/out/bin/Release/Cs2Gs.Cli/cs2gs.dll" migrate \
  --corpus "$source_dir" \
  --out "$migrated_dir" \
  --artifacts "$runs_dir" \
  --config Release | tee "$log_file"
migrate_exit=${PIPESTATUS[0]}
set -e

if (( migrate_exit != 0 )); then
  exit "$migrate_exit"
fi

cli=$(find "$runs_dir" \
  -path "*/src_Oahu.Cli_Oahu.Cli.csproj-*/bin/src/Oahu.Cli/bin/Release/net10.0/oahu-cli.dll" \
  -print -quit)
app=$(find "$runs_dir" \
  -path "*/src_Oahu.App_Oahu.App.csproj-*/bin/src/Oahu.App/bin/Release/net10.0/Oahu.dll" \
  -print -quit)
if [[ -z "$cli" || -z "$app" ]]; then
  echo "Could not locate migrated Oahu runtime binaries." >&2
  exit 1
fi

mkdir -p "$smoke_dir/config" "$smoke_dir/data" "$smoke_dir/log" "$smoke_dir/home"

export HOME="$smoke_dir/home"
export DOTNET_CLI_HOME="$smoke_dir/home"
export DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export XDG_CONFIG_HOME="$smoke_dir/config"
export XDG_DATA_HOME="$smoke_dir/data"
export XDG_STATE_HOME="$smoke_dir/log"
export OAHU_NO_TUI=1
export NO_COLOR=1

dotnet "$cli" --version > "$smoke_dir/version.txt"
dotnet "$cli" --help > "$smoke_dir/help.txt"
set +e
dotnet "$cli" \
  --config-dir "$smoke_dir/config" \
  --log-dir "$smoke_dir/log" \
  --json auth status > "$smoke_dir/auth-status.json"
auth_status_exit=$?
set -e
if [[ "$(uname -s)" == "Darwin" ]]; then
  # .NET resolves LocalApplicationData from the macOS account rather than HOME.
  jq -e '
    ._schemaVersion == "1" and
    .resource == "auth-status" and
    (.count | type == "number") and
    (.items | type == "array") and
    .count == (.items | length)
  ' "$smoke_dir/auth-status.json" > /dev/null
else
  jq -e '
    ._schemaVersion == "1" and
    .resource == "auth-status" and
    .count == 0 and
    (.items | type == "array" and length == 0)
  ' "$smoke_dir/auth-status.json" > /dev/null
fi
auth_count=$(jq -r '.count' "$smoke_dir/auth-status.json")
expected_auth_exit=$((auth_count == 0 ? 3 : 0))
if (( auth_status_exit != expected_auth_exit )); then
  echo "Expected auth status exit $expected_auth_exit for $auth_count profiles, got $auth_status_exit." >&2
  exit 1
fi
dotnet "$app" --smoke-test

echo "Oahu C# and migrated G# validation passed."
