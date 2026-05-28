#!/usr/bin/env bash
# Validates multi-file compilation: a .gsproj with multiple .gs files that
# reference symbols across files, all auto-globbed by the SDK (no explicit
# <Compile> items). Packs Gsharp.NET.Sdk, builds samples/MultiFile, runs
# the produced assembly, and asserts expected output.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Packing Gsharp.NET.Sdk into .nugs/"
dotnet build src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.csproj -c Release --nologo -v:q
mkdir -p .nugs
cp out/bin/Release/nupkgs/Gsharp.NET.Sdk.*.nupkg .nugs/

NUPKG=$(ls -t out/bin/Release/nupkgs/Gsharp.NET.Sdk.*.nupkg | head -1)
VER="${NUPKG##*Gsharp.NET.Sdk.}"
VER="${VER%.nupkg}"

echo "==> Pinning samples/MultiFile/global.json to Gsharp.NET.Sdk $VER"
cat > samples/MultiFile/global.json <<EOF
{
  "msbuild-sdks": {
    "Gsharp.NET.Sdk": "$VER"
  }
}
EOF

rm -rf "$HOME/.nuget/packages/gsharp.net.sdk/$VER" || true

echo "==> dotnet build samples/MultiFile/MultiFile.gsproj"
rm -rf samples/MultiFile/bin samples/MultiFile/obj
dotnet build samples/MultiFile/MultiFile.gsproj --nologo

OUT="samples/MultiFile/bin/Debug/net10.0/MultiFile.dll"
echo "==> dotnet $OUT"
ACTUAL=$(dotnet "$OUT")
EXPECTED="[Hello, multi-file!]"

if [[ "$ACTUAL" != "$EXPECTED" ]]; then
    echo "FAIL: expected '$EXPECTED', got '$ACTUAL'"
    exit 1
fi

echo "PASS: multi-file compilation produces a runnable assembly with cross-file symbol resolution."
