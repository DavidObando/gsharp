#!/usr/bin/env bash
# ADR-0051 E2E: validates that GSharp-declared properties (auto, computed,
# virtual/override) are fully consumable from a C# project via ProjectReference.
# Exercises: property get/set, object initializers, System.Text.Json
# serialization, and virtual dispatch through the base type.
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

echo "==> Pinning samples/PropertyRef/global.json to Gsharp.NET.Sdk $VER"
cat > samples/PropertyRef/global.json <<EOF
{
  "msbuild-sdks": {
    "Gsharp.NET.Sdk": "$VER"
  }
}
EOF

rm -rf "$HOME/.nuget/packages/gsharp.net.sdk/$VER" || true

SAMPLE="samples/PropertyRef"

echo "==> Clean build of Lib + CSharpApp"
rm -rf "$SAMPLE"/Lib/bin "$SAMPLE"/Lib/obj \
       "$SAMPLE"/CSharpApp/bin "$SAMPLE"/CSharpApp/obj

dotnet build "$SAMPLE/CSharpApp/CSharpApp.csproj" --nologo

echo "==> Running C# app that consumes GSharp properties"
ACTUAL=$(dotnet "$SAMPLE/CSharpApp/bin/Debug/net10.0/CSharpApp.dll")

EXPECTED="Alice,30
42
42
0
100
Woof
Meow
Bob,25
Carol,40"

if [[ "$ACTUAL" != "$EXPECTED" ]]; then
    echo "FAIL: output mismatch"
    echo "--- expected ---"
    echo "$EXPECTED"
    echo "--- actual ---"
    echo "$ACTUAL"
    exit 1
fi

echo "PASS: GSharp properties (auto, computed, virtual/override) are fully consumable from C# — including object initializers and System.Text.Json serialization."
