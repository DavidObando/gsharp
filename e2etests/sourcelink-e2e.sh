#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
SCRATCH="$ROOT/out/test/sourcelink-build-$$"
mkdir -p "$SCRATCH"
trap 'rm -rf "$SCRATCH"' EXIT
export TMPDIR="$SCRATCH" TEMP="$SCRATCH" TMP="$SCRATCH"

dotnet build src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj \
    --configuration Release --no-restore -graph -nr:false --nologo -v:q
GSHARP_SOURCELINK_SDK_PACKAGE="$(ls -t "$ROOT"/out/bin/Release/nupkgs/Gsharp.NET.Sdk.[0-9]*.nupkg | head -1)"
export GSHARP_SOURCELINK_SDK_PACKAGE
python3 e2etests/sourcelink-e2e.py
