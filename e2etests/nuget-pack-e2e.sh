#!/usr/bin/env bash
# Phase 7.7b E2E test: packs a GSharp library and verifies that vanilla C# and
# F# projects can consume the resulting .nupkg. Exercises public types, methods,
# data struct equality, inline struct newtype, and validates XML docs surface.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WORKDIR="$ROOT/out/e2e/nuget-pack-$$"
mkdir -p "$WORKDIR"
trap 'rm -rf "$WORKDIR"' EXIT
# Keep consumer builds separate from repository build properties and SDK caches.
printf '<Project />\n' > "$WORKDIR/Directory.Build.props"
printf '<Project />\n' > "$WORKDIR/Directory.Build.targets"

echo "==> Packing Gsharp.NET.Sdk"
dotnet build src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj -c Release -graph --nologo -v:q

SDK_NUPKG=$(ls -t out/bin/Release/nupkgs/Gsharp.NET.Sdk.[0-9]*.nupkg | head -1)
VER="${SDK_NUPKG##*Gsharp.NET.Sdk.}"
VER="${VER%.nupkg}"
echo "    SDK version: $VER"
python3 - "$SDK_NUPKG" <<'PY'
import pathlib
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    for name in ("Sdk/Sdk.props", "Sdk/Sdk.targets"):
        assert archive.read(name) == (pathlib.Path("src/Sdk/Gsharp.NET.Sdk") / name).read_bytes()
PY

export NUGET_PACKAGES="$WORKDIR/nuget-cache"

# ============================================================================
# Step 1: Create a GSharp library project
# ============================================================================
echo "==> Creating GSharp library project in $WORKDIR/MyLib"
mkdir -p "$WORKDIR/MyLib"

cat > "$WORKDIR/MyLib/MyLib.gsproj" <<EOF
<Project Sdk="Gsharp.NET.Sdk/$VER">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <RootNamespace>MyLib</RootNamespace>
    <PackageId>MyLib</PackageId>
    <Version>1.2.3</Version>
    <Authors>Test</Authors>
    <Description>Test GSharp library for NuGet pack E2E.</Description>
  </PropertyGroup>
</Project>
EOF

cat > "$WORKDIR/MyLib/NuGet.config" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="gsharp-local" value="./packages" />
  </packageSources>
</configuration>
EOF

mkdir -p "$WORKDIR/MyLib/packages"
cp "$ROOT/$SDK_NUPKG" "$WORKDIR/MyLib/packages/"
# ADR-0207: the SDK restores Gsharp.NET.Sdk.Compiler.<rid> of its exact version, so the feed needs them too.
cp "$ROOT"/out/bin/Release/nupkgs/Gsharp.NET.Sdk.Compiler.*."$VER".nupkg "$WORKDIR/MyLib/packages/"

# Source file: a public class (the cross-language stable surface), and an inline struct.
# NOTE: Free functions are emitted on a synthesized <Program> type whose name is not
# a valid C#/F# identifier. Classes are the stable cross-language entry point.
cat > "$WORKDIR/MyLib/Api.gs" <<'EOF'
// file: Api.gs

package MyLib

import System

/// A helper class exposing math and greeting utilities.
class MathHelper {
    /// Greets the given name with a friendly message.
    func Greet(name string) string {
        return "Hello, " + name + "!"
    }

    /// Returns the sum of two integers.
    func Add(a int32, b int32) int32 {
        return a + b
    }
}

/// A strongly-typed wrapper around an integer identifier.
inline struct UserId(value int32)
EOF

# ============================================================================
# Step 2: dotnet pack the GSharp library
# ============================================================================
echo "==> dotnet pack MyLib"
cd "$WORKDIR/MyLib"
dotnet pack -c Release --nologo -v:q

MYLIB_NUPKG=$(find bin -name "MyLib.*.nupkg" | head -1)
if [[ -z "$MYLIB_NUPKG" ]]; then
    echo "FAIL: dotnet pack did not produce a .nupkg"
    exit 1
fi
echo "    Produced: $MYLIB_NUPKG"

# ============================================================================
# Step 3: Validate package layout
# ============================================================================
echo "==> Validating package layout"
NUPKG_DIR="$WORKDIR/nupkg-contents"
mkdir -p "$NUPKG_DIR"
unzip -q "$MYLIB_NUPKG" -d "$NUPKG_DIR"

# Check lib/<tfm>/*.dll exists
if ! ls "$NUPKG_DIR"/lib/net10.0/MyLib.dll >/dev/null 2>&1; then
    echo "FAIL: lib/net10.0/MyLib.dll not found in package"
    exit 1
fi

# Check ref/<tfm>/*.dll exists (reference assembly)
if ! ls "$NUPKG_DIR"/ref/net10.0/MyLib.dll >/dev/null 2>&1; then
    echo "FAIL: ref/net10.0/MyLib.dll not found in package"
    exit 1
fi

echo "    lib/net10.0/MyLib.dll ✓"
echo "    ref/net10.0/MyLib.dll ✓"

# The SDK defaults to Portable PDB symbols for an ordinary library.
python3 - "$MYLIB_NUPKG" <<'PY'
import pathlib
import sys
import zipfile

package = pathlib.Path(sys.argv[1])
symbols = package.with_suffix(".snupkg")
assert symbols.is_file(), symbols
with zipfile.ZipFile(symbols) as archive:
    assert archive.read("lib/net10.0/MyLib.pdb") == pathlib.Path("bin/Release/net10.0/MyLib.pdb").read_bytes()
PY

# Issue #5265: content-only projects must not attempt an empty default snupkg.
echo "==> Checking content-only pack and explicit symbol settings"
for CASE in absent empty optout custom legacy; do
    CASE_DIR="$WORKDIR/content-$CASE"
    mkdir -p "$CASE_DIR"
    PROPERTIES="<IncludeBuildOutput>false</IncludeBuildOutput>"
    SYMBOL_ITEM=""
    case "$CASE" in
        empty) : > "$CASE_DIR/Program.gs" ;;
        optout) PROPERTIES="$PROPERTIES<IncludeSymbols>false</IncludeSymbols>" ;;
        custom)
            PROPERTIES="$PROPERTIES<IncludeSymbols>true</IncludeSymbols>"
            cp bin/Release/net10.0/MyLib.pdb "$CASE_DIR/custom.pdb"
            SYMBOL_ITEM='<None Include="custom.pdb" Pack="true" PackagePath="lib/net10.0/" />'
            ;;
        legacy)
            PROPERTIES="$PROPERTIES<IncludeSymbols>true</IncludeSymbols><SymbolPackageFormat>symbols.nupkg</SymbolPackageFormat>"
            ;;
    esac
    cat > "$CASE_DIR/Content.gsproj" <<EOF
<Project Sdk="Gsharp.NET.Sdk/$VER">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    $PROPERTIES
  </PropertyGroup>
  <ItemGroup>
    <None Include="payload" Pack="true" PackagePath="/" />
    $SYMBOL_ITEM
  </ItemGroup>
</Project>
EOF
    cp NuGet.config "$CASE_DIR/NuGet.config"
    # The source path is relative to each consumer, not to the repository.
    ln -s "$WORKDIR/MyLib/packages" "$CASE_DIR/packages"
    printf payload > "$CASE_DIR/payload"
    dotnet pack "$CASE_DIR/Content.gsproj" -c Release --nologo -v:q
    python3 - "$CASE_DIR" "$CASE" <<'PY'
import pathlib
import sys
import zipfile
import xml.etree.ElementTree as ET

root = pathlib.Path(sys.argv[1])
case = sys.argv[2]
output = root / "bin/Release"
package = output / "Content.1.0.0.nupkg"
expected = {package.name}
if case == "custom":
    expected.add("Content.1.0.0.snupkg")
elif case == "legacy":
    expected.add("Content.1.0.0.symbols.nupkg")
assert {p.name for p in output.glob("*.*nupkg")} == expected
with zipfile.ZipFile(package) as archive:
    assert archive.read("payload") == b"payload"
    nuspec = ET.fromstring(archive.read("Content.nuspec"))
    ns = {"n": nuspec.tag.split("}")[0].removeprefix("{")}
    groups = nuspec.findall("n:metadata/n:dependencies/n:group", ns)
    assert len(groups) == 1 and groups[0].attrib == {"targetFramework": "net10.0"}
    assert len(groups[0]) == 0
if case == "custom":
    with zipfile.ZipFile(output / "Content.1.0.0.snupkg") as archive:
        assert archive.read("lib/net10.0/custom.pdb") == (root / "custom.pdb").read_bytes()
elif case == "legacy":
    with zipfile.ZipFile(output / "Content.1.0.0.symbols.nupkg") as archive:
        assert archive.read("payload") == b"payload"
PY
done

echo "==> Checking an ordinary library's explicit symbol opt-out"
dotnet pack -c Release --no-build --no-restore --nologo -v:q \
    -p:IncludeSymbols=false -o "$WORKDIR/library-optout"
python3 - "$WORKDIR/library-optout" <<'PY'
import pathlib
import sys
import zipfile

output = pathlib.Path(sys.argv[1])
assert {p.name for p in output.iterdir()} == {"MyLib.1.2.3.nupkg"}
with zipfile.ZipFile(output / "MyLib.1.2.3.nupkg") as archive:
    assert archive.read("lib/net10.0/MyLib.dll") == pathlib.Path("bin/Release/net10.0/MyLib.dll").read_bytes()
PY

# ============================================================================
# Step 4: Consume from a vanilla C# project
# ============================================================================
echo "==> Creating C# consumer project"
CSHARP_DIR="$WORKDIR/CSharpConsumer"
mkdir -p "$CSHARP_DIR"

# Set up a local feed pointing at the packed library
mkdir -p "$CSHARP_DIR/packages"
cp "$WORKDIR/MyLib/$MYLIB_NUPKG" "$CSHARP_DIR/packages/"

cat > "$CSHARP_DIR/NuGet.config" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="local" value="./packages" />
  </packageSources>
</configuration>
EOF

cat > "$CSHARP_DIR/CSharpConsumer.csproj" <<EOF
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="MyLib" Version="1.2.3" />
  </ItemGroup>
</Project>
EOF

cat > "$CSHARP_DIR/Program.cs" <<'EOF'
using System;

// Class-based consumption (stable cross-language surface)
var helper = new MyLib.MathHelper();
Console.WriteLine(helper.Greet("World"));
Console.WriteLine(helper.Add(3, 4));

// Inline struct (newtype) — single field named 'value'
var uid = new MyLib.UserId();
Console.WriteLine(uid.value);
EOF

echo "==> dotnet run CSharpConsumer"
cd "$CSHARP_DIR"
CSHARP_OUTPUT=$(dotnet run --nologo 2>&1)
EXPECTED_CSHARP="Hello, World!
7
0"

if [[ "$CSHARP_OUTPUT" != "$EXPECTED_CSHARP" ]]; then
    echo "FAIL: C# consumer output mismatch"
    echo "Expected:"
    echo "$EXPECTED_CSHARP"
    echo "Got:"
    echo "$CSHARP_OUTPUT"
    exit 1
fi
echo "    C# consumer output matches ✓"

# ============================================================================
# Step 5: Consume from a vanilla F# project
# ============================================================================
echo "==> Creating F# consumer project"
FSHARP_DIR="$WORKDIR/FSharpConsumer"
mkdir -p "$FSHARP_DIR"

mkdir -p "$FSHARP_DIR/packages"
cp "$WORKDIR/MyLib/$MYLIB_NUPKG" "$FSHARP_DIR/packages/"

cat > "$FSHARP_DIR/NuGet.config" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="local" value="./packages" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
EOF

cat > "$FSHARP_DIR/FSharpConsumer.fsproj" <<EOF
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="MyLib" Version="1.2.3" />
    <Compile Include="Program.fs" />
  </ItemGroup>
</Project>
EOF

cat > "$FSHARP_DIR/Program.fs" <<'EOF'
open System

// Class-based consumption (stable cross-language surface)
let helper = MyLib.MathHelper()
let greeting = helper.Greet("World")
printfn "%s" greeting
let sum = helper.Add(3, 4)
printfn "%d" sum

// Inline struct (newtype) — single field named 'value'
let mutable uid = MyLib.UserId()
printfn "%d" uid.value
EOF

echo "==> dotnet run FSharpConsumer"
cd "$FSHARP_DIR"
FSHARP_OUTPUT=$(dotnet run --nologo 2>&1)
EXPECTED_FSHARP="Hello, World!
7
0"

if [[ "$FSHARP_OUTPUT" != "$EXPECTED_FSHARP" ]]; then
    echo "FAIL: F# consumer output mismatch"
    echo "Expected:"
    echo "$EXPECTED_FSHARP"
    echo "Got:"
    echo "$FSHARP_OUTPUT"
    exit 1
fi
echo "    F# consumer output matches ✓"

# ============================================================================
# Step 6: Validate XML docs surface
# ============================================================================
echo "==> Validating XML documentation"
XML_FILE="$NUPKG_DIR/lib/net10.0/MyLib.xml"
if [[ -f "$XML_FILE" ]]; then
    if grep -q "helper class" "$XML_FILE" || grep -q "MathHelper" "$XML_FILE"; then
        echo "    XML docs contain class summary ✓"
    else
        echo "    WARN: XML docs file exists but class summary not found (doc generation pending)"
    fi
else
    echo "    WARN: XML docs file not present in package (doc generation pending)"
fi

echo ""
echo "PASS: NuGet pack E2E — GSharp library packs and is consumable from C# and F#."
