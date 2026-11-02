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
E2E_DIR="$ROOT/e2etests"

# Collect test scripts (sorted for deterministic ordering).
if [[ $# -gt 0 ]]; then
    # Run specific tests by prefix (e.g. "sdk" runs "sdk-e2e.sh").
    SCRIPTS=()
    for name in "$@"; do
        script="$E2E_DIR/${name}-e2e.sh"
        if [[ ! -f "$script" ]]; then
            echo "ERROR: $script not found"
            exit 1
        fi
        SCRIPTS+=("$script")
    done
else
    SCRIPTS=()
    while IFS= read -r script; do
        SCRIPTS+=("$script")
    done < <(find "$E2E_DIR" -maxdepth 1 -name '*-e2e.sh' -type f | sort)
fi

if [[ ${#SCRIPTS[@]} -eq 0 ]]; then
    echo "No e2e test scripts found in $E2E_DIR"
    exit 1
fi

echo "========================================"
echo " GSharp End-to-End Test Suite"
echo " ${#SCRIPTS[@]} test(s) discovered"
echo "========================================"
echo ""

echo "==> Packing Gsharp.NET.Sdk into .nugs/ once for the E2E suite"
dotnet build "$ROOT/src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj" -c Release -graph --nologo -v:q
mkdir -p "$ROOT/.nugs"
cp "$ROOT"/out/bin/Release/nupkgs/Gsharp.NET.Sdk.*.nupkg "$ROOT/.nugs/"
SDK_NUPKG=$(ls -t "$ROOT"/out/bin/Release/nupkgs/Gsharp.NET.Sdk.[0-9]*.nupkg | head -1)
SDK_VER="${SDK_NUPKG##*Gsharp.NET.Sdk.}"
SDK_VER="${SDK_VER%.nupkg}"
rm -rf "${HOME:-$PWD}/.nuget/packages/gsharp.net.sdk/$SDK_VER" || true
export GSHARP_E2E_SDK_PACKED=1
export GSHARP_R2R_NUPKG_DIR="$ROOT/out/bin/Release/nupkgs"
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
