#!/usr/bin/env bash
# Discovers and runs all *-e2e.sh scripts in the build/ directory.
# New e2e test files are automatically picked up — just add a file matching
# the `*-e2e.sh` pattern and it will run as part of the suite.
#
# Usage:
#   ./build/run-e2e-tests.sh          # run all e2e tests
#   ./build/run-e2e-tests.sh sdk      # run only sdk-e2e.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT/build"

# Collect test scripts (sorted for deterministic ordering).
if [[ $# -gt 0 ]]; then
    # Run specific tests by prefix (e.g. "sdk" runs "sdk-e2e.sh").
    SCRIPTS=()
    for name in "$@"; do
        script="$BUILD_DIR/${name}-e2e.sh"
        if [[ ! -f "$script" ]]; then
            echo "ERROR: $script not found"
            exit 1
        fi
        SCRIPTS+=("$script")
    done
else
    mapfile -t SCRIPTS < <(find "$BUILD_DIR" -maxdepth 1 -name '*-e2e.sh' -type f | sort)
fi

if [[ ${#SCRIPTS[@]} -eq 0 ]]; then
    echo "No e2e test scripts found in $BUILD_DIR"
    exit 1
fi

echo "========================================"
echo " GSharp End-to-End Test Suite"
echo " ${#SCRIPTS[@]} test(s) discovered"
echo "========================================"
echo ""

PASSED=0
FAILED=0
SKIPPED=0
FAILURES=()

for script in "${SCRIPTS[@]}"; do
    name="$(basename "$script" .sh)"
    echo "────────────────────────────────────────"
    echo "▶ $name"
    echo "────────────────────────────────────────"

    set +e
    output=$("$script" 2>&1)
    rc=$?
    set -e

    echo "$output"
    echo ""

    if [[ $rc -eq 0 ]]; then
        if echo "$output" | grep -q "^SKIP:"; then
            echo "⏭  $name: SKIPPED"
            SKIPPED=$((SKIPPED + 1))
        else
            echo "✅ $name: PASSED"
            PASSED=$((PASSED + 1))
        fi
    else
        echo "❌ $name: FAILED (exit code $rc)"
        FAILED=$((FAILED + 1))
        FAILURES+=("$name")
    fi
    echo ""
done

echo "========================================"
echo " Results: $PASSED passed, $FAILED failed, $SKIPPED skipped"
echo "========================================"

if [[ $FAILED -gt 0 ]]; then
    echo ""
    echo "Failed tests:"
    for f in "${FAILURES[@]}"; do
        echo "  - $f"
    done
    exit 1
fi
