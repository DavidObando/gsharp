#!/usr/bin/env bash
#
# migrate-l1.sh — proves the issue #914 canonicalization milestone end-to-end:
# the L1-Console corpus migrates from C# to G# and runs with identical output.
#
# Steps:
#   1. Translate corpus/L1-Console/Program.cs to canonical G# (T1 tuples,
#      T2 immutable-field init, T3 entry-point -> top-level).
#   2. Assert the printed G# round-trip-parses.
#   3. Compile it with the REAL gsc (zero errors).
#   4. Run the produced program and assert stdout == baseline.stdout.golden.
#
# Steps 1-2 and the translation invariants are asserted by
# L1MigrationEndToEndTests.L1Corpus_CanonicalizesWithAllThreeTransforms; steps
# 3-4 (the real gsc compile + exact stdout parity) by
# L1MigrationEndToEndTests.L1Corpus_CompilesWithGscAndMatchesBaseline, which is
# active once the compiler (gsc.dll) is built. This script builds the solution
# (so gsc.dll exists) and then runs those tests.
#
# Usage: tools/cs2gs/scripts/migrate-l1.sh [-c Release|Debug]

set -euo pipefail

CONFIG="Release"
while getopts "c:" opt; do
  case "$opt" in
    c) CONFIG="$OPTARG" ;;
    *) echo "usage: $0 [-c Release|Debug]" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

echo "==> Building GSharp.sln ($CONFIG) so the real gsc compiler is available"
dotnet build GSharp.sln -c "$CONFIG" -graph

echo "==> Running the L1 end-to-end migration tests (translate -> round-trip -> gsc -> run -> stdout parity)"
dotnet test tools/cs2gs/Cs2Gs.Tests/Cs2Gs.Tests.csproj -c "$CONFIG" \
  --filter "FullyQualifiedName~L1MigrationEndToEndTests"

echo "==> L1 migrated clean: gsc compiled with zero errors and stdout matched baseline.stdout.golden"
