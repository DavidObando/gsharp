#!/usr/bin/env bash
# ILVerify gate over gsc-emitted sample assemblies (issue #3163).
#
# Compiles every golden sample under samples/ with gsc (the same corpus and
# compile flags the SampleConformanceTests harness uses) and runs the
# repo-pinned dotnet-ilverify local tool (.config/dotnet-tools.json) over each
# emitted assembly. Any IL verification error that is not listed in
# build/ilverify-known-failures.txt fails the gate, turning
# silent-invalid-IL emitter bugs into loud CI failures without waiting on the
# 45-minute test matrix.
#
# Corpus (mirrors test/Compiler.Tests/LanguageConformance/SampleConformanceData.cs):
#   - single-file: samples/*.gs that have a sibling *.golden
#   - multi-file:  samples/<dir>/ (except aspirational/) containing *.gs and
#                  <dir>/<dir>.golden
# Samples without a golden are not part of the conformance corpus and are
# skipped; every golden sample is expected to compile with exit code 0, so a
# gsc failure here is also a gate failure.
#
# Known-failure baseline (build/ilverify-known-failures.txt): each line is
#   <AssemblyBaseName> <comma-separated-ilverify-error-codes>
# The listed codes are passed to ilverify as `-g <code>` ignore flags for that
# assembly only, so existing documented debt stays green while any NEW error
# (either a new code on a listed assembly or any error on an unlisted
# assembly) breaks the gate. The stricter method-scoped version of these
# suppressions still runs inside the conformance suite
# (test/Compiler.Tests/IlVerifier.cs, GetKnownIssuesForSample).
#
# Usage:
#   ./build/run-ilverify.sh              # full gate
#   ./build/run-ilverify.sh Arithmetic   # only samples whose base name matches
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CONFIG=Release
GSC_DLL="$ROOT/out/bin/$CONFIG/Compiler/gsc.dll"
EXTENSIONS_DLL="$ROOT/out/bin/$CONFIG/Gsharp.Extensions/Gsharp.Extensions.dll"
CHANNELS_DLL="$ROOT/out/bin/$CONFIG/Gsharp.Runtime.Channels/Gsharp.Runtime.Channels.dll"
SAMPLES_DIR="$ROOT/samples"
BASELINE_FILE="$ROOT/build/ilverify-known-failures.txt"
TMP_BASE="${TMPDIR:-/tmp}"
OUT_DIR="${GSHARP_ILVERIFY_OUT:-$(mktemp -d "${TMP_BASE%/}/gsharp-ilverify.XXXXXX")}"
FILTER="${1:-}"

cleanup() {
    if [[ -z "${GSHARP_ILVERIFY_OUT:-}" ]]; then
        rm -rf "$OUT_DIR"
    fi
}
trap cleanup EXIT

echo "==> Building gsc, Gsharp.Runtime.Channels and Gsharp.Extensions ($CONFIG)"
# Gsharp.Extensions -> Gsharp.NET.Sdk packs gsgen via a raw <MSBuild> task, so
# its restore does not flow transitively; restore the solution like CI does.
dotnet restore GSharp.sln --nologo -v:q
dotnet build src/Compiler/Compiler.csproj -c "$CONFIG" --no-restore --nologo -v:q
dotnet build src/Sdk/Gsharp.Extensions/Gsharp.Extensions.csproj -c "$CONFIG" --no-restore --nologo -v:q
[[ -f "$GSC_DLL" ]] || { echo "ERROR: gsc not found at $GSC_DLL"; exit 1; }
[[ -f "$EXTENSIONS_DLL" ]] || { echo "ERROR: Gsharp.Extensions not found at $EXTENSIONS_DLL"; exit 1; }
# ADR-0174 D1: the channel runtime is a Compiler ProjectReference, so it is built transitively.
[[ -f "$CHANNELS_DLL" ]] || { echo "ERROR: Gsharp.Runtime.Channels not found at $CHANNELS_DLL"; exit 1; }

echo "==> Restoring repo-local dotnet tools (dotnet-ilverify)"
if ! dotnet tool run ilverify --version >/dev/null 2>&1; then
    dotnet tool restore
fi
echo "    ilverify $(dotnet tool run ilverify --version)"

# Reference set: the newest host Microsoft.NETCore.App 10.x BCL, filtered the
# same way as test/Compiler.Tests/IlVerifier.cs (System.*, mscorlib,
# netstandard, plus the few Microsoft.* facades). This matches the implicit
# references gsc resolves for /targetframework:net10.0.
RUNTIME_DIR="$(dotnet --list-runtimes \
    | awk '$1 == "Microsoft.NETCore.App" && $2 ~ /^10\./ { path = $3; ver = $2 }
           END { if (ver != "") { gsub(/[\[\]]/, "", path); print path "/" ver } }')"
[[ -n "$RUNTIME_DIR" && -d "$RUNTIME_DIR" ]] || {
    echo "ERROR: could not locate a Microsoft.NETCore.App 10.x runtime via 'dotnet --list-runtimes'"
    exit 1
}
echo "==> BCL reference dir: $RUNTIME_DIR"

REF_ARGS=()
for dll in "$RUNTIME_DIR"/System.*.dll \
           "$RUNTIME_DIR"/mscorlib.dll \
           "$RUNTIME_DIR"/netstandard.dll \
           "$RUNTIME_DIR"/Microsoft.CSharp.dll \
           "$RUNTIME_DIR"/Microsoft.VisualBasic.Core.dll \
           "$RUNTIME_DIR"/Microsoft.Win32.Primitives.dll \
           "$RUNTIME_DIR"/Microsoft.Win32.Registry.dll; do
    [[ -f "$dll" ]] && REF_ARGS+=(-r "$dll")
done
# ADR-0174 D1: emitted programs reference the channel runtime whenever they
# construct or operate on a channel; it is not a BCL assembly, so add it.
REF_ARGS+=(-r "$CHANNELS_DLL")

# Baseline: map assembly base name -> comma-separated ignored error codes.
baseline_codes() {
    local name="$1"
    [[ -f "$BASELINE_FILE" ]] || return 0
    # Strip comments/blank lines; first field is the name, second the codes.
    awk -v name="$name" '
        /^[[:space:]]*(#|$)/ { next }
        $1 == name { print $2; exit }
    ' "$BASELINE_FILE"
}

PASSED=0
SUPPRESSED=0
FAILED=0
COMPILE_FAILED=0
FAILURES=()

verify_sample() {
    local name="$1"; shift
    local uses_extensions="$1"; shift
    local sources=("$@")

    if [[ -n "$FILTER" && "$name" != *"$FILTER"* ]]; then
        return 0
    fi

    local sample_out="$OUT_DIR/$name"
    mkdir -p "$sample_out"
    local dll="$sample_out/$name.dll"

    # Mirror SampleConformanceTests.RunEmittedAsync's gsc invocation.
    local gsc_args=("/out:$dll" "/target:exe" "/targetframework:net10.0" "/nowarn:GS9100")
    if [[ "$uses_extensions" == "yes" ]]; then
        gsc_args+=("/r:$EXTENSIONS_DLL")
    fi
    gsc_args+=("${sources[@]}")

    local compile_output
    if ! compile_output="$(dotnet "$GSC_DLL" "${gsc_args[@]}" 2>&1)"; then
        echo "FAIL(compile) $name"
        echo "$compile_output" | sed 's/^/    /'
        COMPILE_FAILED=$((COMPILE_FAILED + 1))
        FAILURES+=("$name (gsc compile failed)")
        return 0
    fi

    local ignore_args=()
    local codes
    codes="$(baseline_codes "$name")"
    if [[ -n "$codes" ]]; then
        local code
        while IFS= read -r code; do
            [[ -n "$code" ]] && ignore_args+=(-g "$code")
        done < <(tr ',' '\n' <<< "$codes")
    fi

    local extra_refs=()
    if [[ "$uses_extensions" == "yes" ]]; then
        extra_refs=(-r "$EXTENSIONS_DLL")
    fi

    local verify_output rc=0
    verify_output="$(dotnet tool run ilverify "$dll" -s System.Private.CoreLib \
        "${REF_ARGS[@]}" ${extra_refs[@]+"${extra_refs[@]}"} \
        ${ignore_args[@]+"${ignore_args[@]}"} 2>&1)" || rc=$?

    # Match on the file name, not the full path: ilverify echoes a normalized
    # path that may differ from $dll (e.g. collapsed double slashes).
    if [[ $rc -eq 0 && "$verify_output" == *"All Classes and Methods in "*"/$name.dll Verified."* ]]; then
        if [[ -n "$codes" ]]; then
            echo "PASS(suppressed: $codes) $name"
            SUPPRESSED=$((SUPPRESSED + 1))
        else
            echo "PASS $name"
        fi
        PASSED=$((PASSED + 1))
    else
        echo "FAIL(ilverify rc=$rc) $name"
        echo "$verify_output" | sed 's/^/    /'
        FAILED=$((FAILED + 1))
        FAILURES+=("$name (ilverify rc=$rc)")
    fi
}

echo "==> Compiling and verifying golden samples from $SAMPLES_DIR"

# Single-file samples: samples/*.gs with a sibling .golden.
# A sample needs /r:Gsharp.Extensions when it names that namespace, and also
# when it names Gsharp.Concurrency: ADR-0174 D9's `after`, `tick`, `merge` and
# `chunks` are G#-authored and live in the Extensions assembly even though the
# package is imported implicitly, so a caller never spells "Gsharp.Extensions".
needs_extensions() {
    grep -q -e "Gsharp.Extensions" -e "Gsharp.Concurrency" "$@"
}

for source in "$SAMPLES_DIR"/*.gs; do
    [[ -f "${source%.gs}.golden" ]] || continue
    name="$(basename "$source" .gs)"
    uses_extensions=no
    needs_extensions "$source" && uses_extensions=yes
    verify_sample "$name" "$uses_extensions" "$source"
done

# Multi-file samples: samples/<dir>/ with <dir>.golden and *.gs inside.
for dir in "$SAMPLES_DIR"/*/; do
    dir="${dir%/}"
    name="$(basename "$dir")"
    [[ "$name" == "aspirational" ]] && continue
    [[ -f "$dir/$name.golden" ]] || continue
    sources=()
    while IFS= read -r file; do
        sources+=("$file")
    done < <(find "$dir" -maxdepth 1 -name '*.gs' | sort)
    [[ ${#sources[@]} -gt 0 ]] || continue
    uses_extensions=no
    needs_extensions "${sources[@]}" && uses_extensions=yes
    verify_sample "$name" "$uses_extensions" "${sources[@]}"
done

TOTAL=$((PASSED + FAILED + COMPILE_FAILED))
echo ""
echo "========================================"
echo " ILVerify gate: $PASSED/$TOTAL verified" \
     "($SUPPRESSED with documented suppressions," \
     "$FAILED verification failures, $COMPILE_FAILED compile failures)"
echo "========================================"

if [[ $TOTAL -eq 0 ]]; then
    echo "ERROR: no samples matched — the corpus discovery is broken (or the filter '$FILTER' matched nothing)."
    exit 1
fi

if [[ ${#FAILURES[@]} -gt 0 ]]; then
    echo ""
    echo "Failed assemblies:"
    for f in "${FAILURES[@]}"; do
        echo "  - $f"
    done
    echo ""
    echo "New ilverify findings indicate gsc emitted unverifiable IL. If a finding"
    echo "is a documented ilverify false positive or tracked compiler bug, add it to"
    echo "build/ilverify-known-failures.txt with an issue reference; otherwise fix the emitter."
    exit 1
fi
