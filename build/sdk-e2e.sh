#!/usr/bin/env bash
# Packs Gsharp.NET.Sdk into .nugs/, pins samples/HelloWorld/global.json to the
# resulting version, and runs `dotnet build` + the produced assembly. Use this
# as the canonical end-to-end smoke test for the SDK packaging pipeline.
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

echo "==> Pinning samples/HelloWorld/global.json to Gsharp.NET.Sdk $VER"
cat > samples/HelloWorld/global.json <<EOF
{
  "msbuild-sdks": {
    "Gsharp.NET.Sdk": "$VER"
  }
}
EOF

# Force the NuGet cache to pull our freshly-packed SDK rather than an older
# locally-cached copy with the same version.
rm -rf "$HOME/.nuget/packages/gsharp.net.sdk/$VER" || true

echo "==> dotnet build samples/HelloWorld/HelloWorld.gsproj"
rm -rf samples/HelloWorld/bin samples/HelloWorld/obj
dotnet build samples/HelloWorld/HelloWorld.gsproj --nologo

OUT="samples/HelloWorld/bin/Debug/net10.0/HelloWorld.dll"
echo "==> dotnet $OUT"
ACTUAL=$(dotnet "$OUT")
EXPECTED="Hello, world!"

if [[ "$ACTUAL" != "$EXPECTED" ]]; then
    echo "FAIL: expected '$EXPECTED', got '$ACTUAL'"
    exit 1
fi

echo "PASS: end-to-end SDK build produces a runnable assembly."
