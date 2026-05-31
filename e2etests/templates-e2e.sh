#!/usr/bin/env bash
# Packs Gsharp.NET.Sdk and Gsharp.Templates, installs the templates package,
# scaffolds `dotnet new gsharp-console`, builds the scaffolded project against
# the freshly-packed SDK, and runs the produced assembly. Use this as the
# canonical end-to-end smoke test for the templates pipeline.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WORKDIR="$(mktemp -d -t gsharp-templates-e2e.XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "==> Packing Gsharp.NET.Sdk and Gsharp.Templates"
dotnet build src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.csproj   -c Release --nologo -v:q
dotnet build src/Sdk/Gsharp.Templates/Gsharp.Templates.csproj -c Release --nologo -v:q

SDK_NUPKG=$(ls -t out/bin/Release/nupkgs/Gsharp.NET.Sdk.*.nupkg | head -1)
TPL_NUPKG=$(ls -t out/bin/Release/nupkgs/Gsharp.Templates.*.nupkg | head -1)
VER="${SDK_NUPKG##*Gsharp.NET.Sdk.}"
VER="${VER%.nupkg}"
echo "    SDK package:       $SDK_NUPKG"
echo "    Templates package: $TPL_NUPKG"
echo "    Version:           $VER"

# Force the NuGet cache to pull our freshly-packed SDK rather than an older
# locally-cached copy with the same version.
rm -rf "$HOME/.nuget/packages/gsharp.net.sdk/$VER" || true

echo "==> Reinstalling Gsharp.Templates"
dotnet new uninstall Gsharp.Templates >/dev/null 2>&1 || true
dotnet new install "$TPL_NUPKG" >/dev/null

echo "==> Scaffolding dotnet new gsharp-console -n MyApp in $WORKDIR"
cd "$WORKDIR"
dotnet new gsharp-console -n MyApp >/dev/null
cd MyApp

# Side-load the freshly-packed SDK and add a local NuGet source so the
# scaffolded project can resolve it. The templates no longer ship a NuGet.config
# (it is a dev-only artifact), so the e2e harness provides one here.
mkdir -p packages
cp "$ROOT/$SDK_NUPKG" packages/
cat > NuGet.config <<EOF
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="gsharp-local" value="./packages" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
EOF

echo "==> dotnet build MyApp.gsproj"
dotnet build --nologo -v:q

OUT="bin/Debug/net10.0/MyApp.dll"
echo "==> dotnet $OUT"
ACTUAL=$(dotnet "$OUT")
EXPECTED="Hello from GSharp!"

if [[ "$ACTUAL" != "$EXPECTED" ]]; then
    echo "FAIL: expected '$EXPECTED', got '$ACTUAL'"
    exit 1
fi

echo "==> Cleanup: dotnet new uninstall Gsharp.Templates"
dotnet new uninstall Gsharp.Templates >/dev/null 2>&1 || true

echo "PASS: end-to-end templates pipeline scaffolds, builds, and runs."
