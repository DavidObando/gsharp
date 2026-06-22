#!/usr/bin/env bash
#
# capture-baselines.sh - regenerate the cs2gs C# parity oracle.
#
# For every corpus app this script captures the *C# baseline* that the G# port
# must later reproduce (ADR-0115 section E). It writes small, deterministic,
# text-based artifacts that live next to each app and are committed to git:
#
#   L1-Console/baseline.stdout.golden   <- exact stdout of the console program
#   L2-Library.Tests/baseline.tests.json <- per-test outcomes + pass/fail counts
#   L3-Library.Tests/baseline.tests.json <- per-test outcomes + pass/fail counts
#
# The artifacts intentionally contain NO machine-specific paths, timestamps,
# durations, or run ids so they diff cleanly and stay stable across machines.
#
# Re-run this script ONLY when the C# corpus itself changes; never as a side
# effect of a G# run. Retries of the migration pipeline compare against these
# fixed targets.
#
# Usage:
#   ./capture-baselines.sh            # capture all baselines
#
set -euo pipefail

CORPUS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="Release"

echo "== cs2gs corpus baseline capture =="
echo "corpus: ${CORPUS_DIR}"
echo

# --- L1: console stdout golden ------------------------------------------------
capture_console() {
    local app_dir="$1"
    local proj="$2"
    local golden="${app_dir}/baseline.stdout.golden"

    echo "-- L1 console: ${proj}"
    dotnet build "${app_dir}/${proj}" -c "${CONFIG}" --nologo -v quiet
    # Capture stdout exactly; the program is deterministic by construction.
    dotnet run --project "${app_dir}/${proj}" -c "${CONFIG}" --no-build > "${golden}"
    echo "   wrote ${golden#"${CORPUS_DIR}/"} ($(wc -l < "${golden}" | tr -d ' ') lines)"
    echo
}

# --- L2/L3: xUnit results -> deterministic JSON -------------------------------
capture_tests() {
    local app_dir="$1"
    local proj="$2"
    local results_dir="${app_dir}/.baseline-trx"
    local trx="${results_dir}/results.trx"
    local out_json="${app_dir}/baseline.tests.json"

    echo "-- tests: ${proj}"
    rm -rf "${results_dir}"
    # `dotnet test` returns non-zero if any test fails; the baseline must be green.
    dotnet test "${app_dir}/${proj}" -c "${CONFIG}" --nologo \
        --logger "trx;LogFileName=results.trx" \
        --results-directory "${results_dir}"

    python3 "${CORPUS_DIR}/trx-to-baseline.py" "${trx}" "$(basename "${app_dir}")" > "${out_json}"
    rm -rf "${results_dir}"
    echo "   wrote ${out_json#"${CORPUS_DIR}/"}"
    echo
}

capture_console "${CORPUS_DIR}/L1-Console" "L1-Console.csproj"
capture_tests   "${CORPUS_DIR}/L2-Library.Tests" "L2-Library.Tests.csproj"
capture_tests   "${CORPUS_DIR}/L3-Library.Tests" "L3-Library.Tests.csproj"

echo "== baseline capture complete =="
