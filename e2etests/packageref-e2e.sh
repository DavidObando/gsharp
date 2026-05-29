#!/usr/bin/env bash
# Validates transitive PackageReference: a .gsproj that depends on a NuGet
# package (Newtonsoft.Json) and calls into it at compile time. Verifies that
# @(ReferencePath) correctly flows package assemblies to gsc via /r: flags.
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

echo "==> Pinning samples/PackageRef/global.json to Gsharp.NET.Sdk $VER"
cat > samples/PackageRef/global.json <<EOF
{
  "msbuild-sdks": {
    "Gsharp.NET.Sdk": "$VER"
  }
}
EOF

rm -rf "$HOME/.nuget/packages/gsharp.net.sdk/$VER" || true

echo "==> dotnet build samples/PackageRef/PackageRef.gsproj"
rm -rf samples/PackageRef/bin samples/PackageRef/obj
dotnet build samples/PackageRef/PackageRef.gsproj --nologo

OUT="samples/PackageRef/bin/Debug/net10.0/PackageRef.dll"
echo "==> dotnet $OUT"
ACTUAL=$(dotnet "$OUT")
EXPECTED='"hello"'

if [[ "$ACTUAL" != "$EXPECTED" ]]; then
    echo "FAIL: expected '$EXPECTED', got '$ACTUAL'"
    exit 1
fi

echo "PASS: transitive PackageReference (Newtonsoft.Json) flows through to gsc and produces a runnable assembly."
