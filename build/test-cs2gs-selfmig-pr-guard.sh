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

if [[ -n "${FAKE_MIGRATE_SLEEP:-}" ]]; then
  sleep "$FAKE_MIGRATE_SLEEP"
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
  local migrate_timeout=${5:-} migrate_sleep=${6:-}
  local case_root="$test_root/$name"
  local log="$case_root.log"
  set +e
  PATH="$fake_bin:$PATH" \
    FAKE_RUN_SUCCEEDED="$run_succeeded" \
    FAKE_MIGRATE_EXIT="$migrate_exit" \
    FAKE_MIGRATE_SLEEP="$migrate_sleep" \
    SELFMIG_PR_GUARD_ROOT="$case_root" \
    SELFMIG_PR_GUARD_MIGRATE_TIMEOUT="$migrate_timeout" \
    "$repo_root/build/run-cs2gs-selfmig-pr-guard.sh" >"$log" 2>&1
  local actual_exit=$?
  set -e

  if (( actual_exit != expected_exit )); then
    cat "$log" >&2
    echo "$name: expected exit $expected_exit, got $actual_exit" >&2
    exit 1
  fi

}

run_case success true 0 0
grep -q "PR guard: 8/8 guarded app(s)" "$test_root/success.log"
grep -q "PR guard PASSED." "$test_root/success.log"

run_case migrate-exit-nonzero true 7 7
grep -q "PR guard: 8/8 guarded app(s)" "$test_root/migrate-exit-nonzero.log"
grep -q "migrate exit 7" "$test_root/migrate-exit-nonzero.log"
grep -q "PR guard FAILED: cs2gs reported a global migration failure" "$test_root/migrate-exit-nonzero.log"
! grep -q "PR guard PASSED." "$test_root/migrate-exit-nonzero.log"

run_case run-failed false 0 1
grep -q "PR guard: 8/8 guarded app(s)" "$test_root/run-failed.log"
grep -q "run FAILED" "$test_root/run-failed.log"
grep -q "run succeeded=false" "$test_root/run-failed.log"
! grep -q "PR guard PASSED." "$test_root/run-failed.log"

run_case migrate-timeout true 0 124 1s 2
grep -q "PR guard TIMED OUT: cs2gs migrate exceeded its 1s deadline" "$test_root/migrate-timeout.log"
grep -q "not a push/concurrency cancellation" "$test_root/migrate-timeout.log"
! grep -q "no run.json produced" "$test_root/migrate-timeout.log"

grep -qx '    timeout-minutes: 90' "$repo_root/.github/workflows/cs2gs-pr-guard.yml"
grep -qx '  SELFMIG_PR_GUARD_MIGRATE_TIMEOUT: 75m' \
  "$repo_root/.github/workflows/cs2gs-pr-guard.yml"

echo "selfmig PR guard regressions PASSED."
