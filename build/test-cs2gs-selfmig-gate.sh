#!/usr/bin/env bash
# Regression tests for the PR-time self-migration gate in
# .github/workflows/build.yml (jobs selfmig-scope, selfmig, selfmig-status):
#
#   1. cs2gs-pr-guard-control.sh `relevant-paths` selects exactly the inputs
#      that can affect the migration.
#   2. The scope step fails SAFE: a failed diff or classifier runs the gate.
#   3. The gate job is structurally still a gate: it calls the reusable
#      workflow, `needs` the scope job and every test job, and is skipped
#      unless the scope job says so. Losing any of these silently turns an
#      hours-long gate into an ungated or unscoped one.
#
# Pure bash/awk on purpose: it runs on a stock runner before anything is built.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
test_root="$repo_root/out/test/cs2gs-selfmig-gate"
fake_bin="$test_root/bin"
rm -rf "$test_root"
mkdir -p "$fake_bin"
trap 'rm -rf "$test_root"' EXIT

control="$repo_root/build/cs2gs-pr-guard-control.sh"
workflow="$repo_root/.github/workflows/build.yml"

# --- 1. relevant-paths ------------------------------------------------------

if printf 'docs/self-migration-policy.md\0website/docs/intro.md\0' |
  "$control" relevant-paths; then
  echo "irrelevant paths unexpectedly selected the expensive gate" >&2
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
reusable_path=$(printf '.github/workflows/cs2gs-selfmig.yml\0' | "$control" relevant-paths)
[[ "$reusable_path" == .github/workflows/cs2gs-selfmig.yml ]]
if printf 'x\0' | "$control" cancellation 2>/dev/null; then
  echo "the retired cancellation mode unexpectedly still exists" >&2
  exit 1
fi

# --- 2. scope step fails safe ----------------------------------------------

scope_root="$test_root/scope"
scope_script="$scope_root/scope.sh"
mkdir -p "$scope_root/build" "$scope_root/tmp"
awk '
  $0 == "      - name: Detect changes that can affect the self-migration" { found = 1; next }
  found && $0 == "        run: |" { in_run = 1; next }
  in_run && $0 ~ /^      - name:/ { exit }
  in_run && $0 ~ /^  [a-z]/ { exit }
  in_run { sub(/^          /, ""); print }
' "$workflow" > "$scope_script"
grep -q 'git diff --no-renames --name-only -z' "$scope_script"

cat > "$fake_bin/git" <<'EOF'
#!/usr/bin/env bash
printf 'docs/only.md\0'
exit "${FAKE_DIFF_EXIT:?}"
EOF
chmod +x "$fake_bin/git"

cat > "$scope_root/build/cs2gs-pr-guard-control.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
exit "${FAKE_HELPER_EXIT:?}"
EOF
chmod +x "$scope_root/build/cs2gs-pr-guard-control.sh"

run_scope_case() {
  local name=$1 diff_exit=$2 helper_exit=$3 expected=$4
  local output="$scope_root/$name.output"
  (
    cd "$scope_root"
    PATH="$fake_bin:$PATH" \
      BASE_SHA=base HEAD_SHA=head RUNNER_TEMP="$scope_root/tmp" \
      GITHUB_OUTPUT="$output" GITHUB_STEP_SUMMARY="$scope_root/$name.summary" \
      FAKE_DIFF_EXIT="$diff_exit" FAKE_HELPER_EXIT="$helper_exit" \
      bash "$scope_script" >/dev/null
  )
  grep -qx "run=$expected" "$output"
}

run_scope_case irrelevant 0 1 false
run_scope_case relevant 0 0 true
run_scope_case diff-failure 128 1 true
run_scope_case helper-failure 0 2 true

# --- 3. the gate job is structurally a gate --------------------------------

# job_block <job id>: the job's lines, up to the next top-level job.
job_block() {
  awk -v id="  $1:" '
    $0 == id { in_job = 1; next }
    in_job && $0 ~ /^  [A-Za-z0-9_-]+:/ { exit }
    in_job { print }
  ' "$workflow"
}

fail() {
  echo "self-migration gate structure: $*" >&2
  exit 1
}

gate=$(job_block selfmig)
[[ -n "$gate" ]] || fail "job 'selfmig' is missing from build.yml"

grep -qx '    uses: ./.github/workflows/cs2gs-selfmig.yml' <<< "$gate" ||
  fail "'selfmig' must call ./.github/workflows/cs2gs-selfmig.yml"
[[ -f "$repo_root/.github/workflows/cs2gs-selfmig.yml" ]] ||
  fail "the called workflow file does not exist"
grep -q '^  workflow_call:' "$repo_root/.github/workflows/cs2gs-selfmig.yml" ||
  fail "cs2gs-selfmig.yml is no longer callable (workflow_call)"

needs_line=$(grep -E '^    needs: \[' <<< "$gate" || true)
[[ -n "$needs_line" ]] || fail "'selfmig' has no inline needs list"
for dep in selfmig-scope build tests test-partition e2e ilverify nullable-hygiene cs2gs-corpus; do
  grep -Eq "[[,] ?${dep}[],]" <<< "$needs_line" ||
    fail "'selfmig' must need '$dep'"
done

if_line=$(grep -E '^    if: ' <<< "$gate" || true)
grep -q "github.event_name == 'pull_request'" <<< "$if_line" ||
  fail "'selfmig' must stay pull_request-only"
grep -q "needs.selfmig-scope.outputs.run == 'true'" <<< "$if_line" ||
  fail "'selfmig' must be gated on the scope job's output"

grep -qx '      actions: read' <<< "$gate" ||
  fail "'selfmig' must grant actions: read (duration-map download)"

# The scope job and the always-reported status job must still exist, and the
# status job must depend on both.
[[ -n "$(job_block selfmig-scope)" ]] || fail "job 'selfmig-scope' is missing"
status=$(job_block selfmig-status)
[[ -n "$status" ]] || fail "job 'selfmig-status' is missing"
grep -Eq '^    needs: \[selfmig-scope, selfmig\]' <<< "$status" ||
  fail "'selfmig-status' must need selfmig-scope and selfmig"

# The retired guard must not come back under its old required-check name.
if grep -q 'hot-core-translation-guard' "$workflow"; then
  fail "the retired hot-core-translation-guard job is back"
fi

echo "selfmig gate regressions PASSED."
