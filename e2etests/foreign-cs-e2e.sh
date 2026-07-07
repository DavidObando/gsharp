#!/usr/bin/env bash
# Issue #2214 (ADR-0145 extension): validates that the Gsharp.NET.Sdk
# translates a stray C# `Compile` item — standing in for Nerdbank.
# GitVersioning's generated `ThisAssembly.cs` — into G# and feeds it to gsc,
# using the same gsgen translation core that already back-translates source-
# generator output (ADR-0145 §C). Unlike the MVVM generator sample
# (gsgen-e2e.sh), this build is expected to go fully GREEN: no known cs2gs/gsc
# translation gaps apply to the small const-only ThisAssembly shape.
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

echo "==> Pinning samples/ForeignCompile/global.json to Gsharp.NET.Sdk $VER"
cat > samples/ForeignCompile/global.json <<EOF
{
  "msbuild-sdks": {
    "Gsharp.NET.Sdk": "$VER"
  }
}
EOF

# Force NuGet to re-extract the (same-versioned) SDK so target edits take effect.
rm -rf "$HOME/.nuget/packages/gsharp.net.sdk/$VER" || true

echo "==> dotnet build samples/ForeignCompile/ForeignCompile.gsproj"
rm -rf samples/ForeignCompile/bin samples/ForeignCompile/obj
dotnet build samples/ForeignCompile/ForeignCompile.gsproj --nologo

GSGEN_DIR="samples/ForeignCompile/obj/Debug/net10.0/gsgen"
echo "==> Checking that the stray ThisAssembly.cs was translated under $GSGEN_DIR"
if [[ ! -f "$GSGEN_DIR/ThisAssembly.g.gs" ]]; then
    echo "FAIL: gsgen did not translate ThisAssembly.cs into ThisAssembly.g.gs."
    ls -1 "$GSGEN_DIR" 2>/dev/null || true
    exit 1
fi

echo "----- ThisAssembly.g.gs -----"
cat "$GSGEN_DIR/ThisAssembly.g.gs"

if ! grep -q "AssemblyFileVersion" "$GSGEN_DIR/ThisAssembly.g.gs"; then
    echo "FAIL: translated ThisAssembly.g.gs is missing AssemblyFileVersion."
    exit 1
fi

if ! grep -q "gsgen/ThisAssembly.g.gs" "$GSGEN_DIR/gsgen.manifest"; then
    echo "FAIL: gsgen manifest does not list the translated ThisAssembly.g.gs."
    cat "$GSGEN_DIR/gsgen.manifest" 2>/dev/null || true
    exit 1
fi

OUT="samples/ForeignCompile/bin/Debug/net10.0/ForeignCompile.dll"
echo "==> Running $OUT"
ACTUAL=$(dotnet "$OUT")
EXPECTED='1.2.3.4'
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
    echo "FAIL: expected '$EXPECTED', got '$ACTUAL'"
    exit 1
fi

echo "PASS: the SDK translated the stray ThisAssembly.cs Compile item via gsgen," \
     "fed the result to gsc, and the built app read ThisAssembly.AssemblyFileVersion correctly."
