#!/usr/bin/env bash
# Validates PackageReference flow into gsc's /r: set, in two shapes:
#
#   1. DIRECT — a .gsproj that declares the package (Newtonsoft.Json) and calls
#      into it at compile time.
#   2. TRANSITIVE (issue #3732) — a .gsproj that declares NO package and reaches
#      one only through a ProjectReference to a library that does, where the
#      library never names the package in its public surface. csc does not need
#      such an assembly downstream; gsc's MetadataLoadContext does, so an
#      incomplete reference set surfaces as `GS9997 Could not find assembly`
#      rather than an unresolved-symbol error. NuGet puts the referenced
#      project's packages in the referencing project's assets file and
#      Gsharp.NET.Core.Sdk.targets hands @(ReferencePathWithRefAssemblies) to
#      gsc verbatim — this pins that the closure survives both hops.
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

echo "PASS: direct PackageReference (Newtonsoft.Json) flows through to gsc and produces a runnable assembly."

# --- Issue #3732: a package reached ONLY through a ProjectReference ---
# Scaffolded outside the repository so it restores exactly like an end-user
# graph: no repo Directory.Build.props, no committed lock file, its own feed.
WORK=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/Lib" "$WORK/App"

cat > "$WORK/global.json" <<EOF
{
  "msbuild-sdks": {
    "Gsharp.NET.Sdk": "$VER"
  }
}
EOF

cat > "$WORK/nuget.config" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="nuget" value="https://api.nuget.org/v3/index.json" />
    <add key="gsharp-local" value="$ROOT/.nugs" />
  </packageSources>
  <disabledPackageSources>
    <clear />
  </disabledPackageSources>
</configuration>
EOF

cat > "$WORK/Lib/Lib.gsproj" <<'EOF'
<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <RootNamespace>TransitivePackageLib</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
EOF

# The package type appears only inside a method BODY: Encode's signature is
# `string`, so nothing in Lib's public surface names Newtonsoft.Json.
cat > "$WORK/Lib/Encoder.gs" <<'EOF'
package TransitivePackageLib

import Newtonsoft.Json

class Encoder(Value string) {
    func Encode() string {
        return JsonConvert.SerializeObject(Value)
    }
}
EOF

cat > "$WORK/App/App.gsproj" <<'EOF'
<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <RootNamespace>TransitivePackageApp</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Lib/Lib.gsproj" />
  </ItemGroup>
</Project>
EOF

cat > "$WORK/App/Program.gs" <<'EOF'
package TransitivePackageApp

import System
import TransitivePackageLib

var encoder = Encoder("transitive")
Console.WriteLine(encoder.Encode())
EOF

echo "==> dotnet build (package reached only through a ProjectReference)"
dotnet build "$WORK/App/App.gsproj" --nologo

RSP="$WORK/App/obj/Debug/net10.0/App.rsp"
if ! grep -qi 'newtonsoft\.json' "$RSP"; then
    echo "FAIL: Newtonsoft.Json is absent from the downstream gsc reference set ($RSP)"
    exit 1
fi
echo "    PASS: the transitive package assembly reached gsc as a /r: reference"

ACTUAL=$(dotnet "$WORK/App/bin/Debug/net10.0/App.dll")
EXPECTED='"transitive"'
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
    echo "FAIL: expected '$EXPECTED', got '$ACTUAL'"
    exit 1
fi

echo "PASS: a PackageReference reached only through a ProjectReference flows through to gsc (issue #3732)."
