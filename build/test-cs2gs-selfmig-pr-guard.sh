#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
test_root="$repo_root/out/test/cs2gs-selfmig-pr-guard"
fake_bin="$test_root/bin"
rm -rf "$test_root"
mkdir -p "$fake_bin"
trap 'rm -rf "$test_root"' EXIT

cat > "$fake_bin/dotnet" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == build ]]; then
  exit 0
fi

artifacts=
while (( $# )); do
  if [[ "$1" == --artifacts ]]; then
    artifacts=$2
    break
  fi
  shift
done

mkdir -p "$artifacts/fake-run"
cat > "$artifacts/fake-run/run.json" <<EOF_JSON
{
  "succeeded": ${FAKE_RUN_SUCCEEDED},
  "apps": [
    {"appId":"src/Analyzers/InternalAnalyzers/InternalAnalyzers.csproj","succeeded":true},
    {"appId":"src/Core/Core.csproj","succeeded":true},
    {"appId":"src/Formatting/GSharp.Formatting/GSharp.Formatting.csproj","succeeded":true},
    {"appId":"src/Sdk/Gsharp.Runtime.Channels/Gsharp.Runtime.Channels.csproj","succeeded":true},
    {"appId":"tools/cs2gs/Cs2Gs.CodeModel/Cs2Gs.CodeModel.csproj","succeeded":true},
    {"appId":"tools/cs2gs/Cs2Gs.Pipeline/Cs2Gs.Pipeline.csproj","succeeded":true},
    {"appId":"tools/cs2gs/Cs2Gs.ProjectLoading/Cs2Gs.ProjectLoading.csproj","succeeded":true},
    {"appId":"tools/cs2gs/Cs2Gs.Translator/Cs2Gs.Translator.csproj","succeeded":true}
  ]
}
EOF_JSON
echo "8/8 apps green; run $([[ "$FAKE_RUN_SUCCEEDED" == true ]] && echo PASSED || echo FAILED)."
exit "$FAKE_MIGRATE_EXIT"
EOF
chmod +x "$fake_bin/dotnet"

run_case() {
  local name=$1 run_succeeded=$2 migrate_exit=$3 expected_exit=$4
  local case_root="$test_root/$name"
  local log="$case_root.log"
  set +e
  PATH="$fake_bin:$PATH" \
    FAKE_RUN_SUCCEEDED="$run_succeeded" \
    FAKE_MIGRATE_EXIT="$migrate_exit" \
    SELFMIG_PR_GUARD_ROOT="$case_root" \
    "$repo_root/build/run-cs2gs-selfmig-pr-guard.sh" >"$log" 2>&1
  local actual_exit=$?
  set -e

  if (( actual_exit != expected_exit )); then
    cat "$log" >&2
    echo "$name: expected exit $expected_exit, got $actual_exit" >&2
    exit 1
  fi

  grep -q "PR guard: 8/8 guarded app(s)" "$log"
}

run_case success true 0 0
grep -q "PR guard PASSED." "$test_root/success.log"

run_case migrate-exit-nonzero true 7 7
grep -q "migrate exit 7" "$test_root/migrate-exit-nonzero.log"
grep -q "PR guard FAILED: cs2gs reported a global migration failure" "$test_root/migrate-exit-nonzero.log"
! grep -q "PR guard PASSED." "$test_root/migrate-exit-nonzero.log"

run_case run-failed false 0 1
grep -q "run FAILED" "$test_root/run-failed.log"
grep -q "run succeeded=false" "$test_root/run-failed.log"
! grep -q "PR guard PASSED." "$test_root/run-failed.log"

control="$repo_root/build/cs2gs-pr-guard-control.sh"
if printf 'docs/self-migration-policy.md\0website/docs/intro.md\0' |
  "$control" relevant-paths; then
  echo "irrelevant paths unexpectedly selected the expensive guard" >&2
  exit 1
fi
relevant_path=$(
  printf 'docs/self-migration-policy.md\0src/Core/CodeAnalysis/Binder.cs\0' |
    "$control" relevant-paths
)
[[ "$relevant_path" == src/Core/CodeAnalysis/Binder.cs ]]
linked_path=$(printf 'test/Shared/GoldenFile.cs\0' | "$control" relevant-paths)
[[ "$linked_path" == test/Shared/GoldenFile.cs ]]
config_path=$(printf '.editorconfig\0' | "$control" relevant-paths)
[[ "$config_path" == .editorconfig ]]

timeout_cause=$(printf '%s' \
  '[{"message":"The job has exceeded the maximum execution time of 1h30m0s"},'\
'{"message":"The operation was canceled."}]' |
  "$control" cancellation)
[[ "$timeout_cause" == timeout ]]

superseded_cause=$(printf '%s' \
  '[{"message":"Canceling since a higher priority waiting request for cs2gs-pr-guard-4077 exists"},'\
'{"message":"The operation was canceled."}]' |
  "$control" cancellation)
[[ "$superseded_cause" == superseded ]]

unknown_cause=$(printf '%s' '[{"message":"The operation was canceled."}]' |
  "$control" cancellation)
[[ "$unknown_cause" == unknown ]]

grep -qx '    timeout-minutes: 90' "$repo_root/.github/workflows/cs2gs-pr-guard.yml"
grep -qx '    concurrency:' "$repo_root/.github/workflows/cs2gs-pr-guard.yml"
grep -qx '    name: hot-core cancellation cause' "$repo_root/.github/workflows/cs2gs-pr-guard.yml"
grep -q '::notice title=Hot-core guard superseded::' \
  "$repo_root/.github/workflows/cs2gs-pr-guard.yml"
grep -qx '          if-no-files-found: ignore' \
  "$repo_root/.github/workflows/cs2gs-pr-guard.yml"
grep -q 'git diff --no-renames --name-only -z' \
  "$repo_root/.github/workflows/cs2gs-pr-guard.yml"

echo "selfmig PR guard regressions PASSED."
