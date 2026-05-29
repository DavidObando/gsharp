#!/usr/bin/env bash
# Packs Gsharp.NET.Sdk into .nugs/ and verifies the debug-information
# pipeline (#95 / #50) end-to-end via the SDK:
#   * <DebugType>portable</DebugType> produces a sibling .pdb next to the assembly
#     and a CodeView debug directory entry in the PE.
#   * <DebugType>embedded</DebugType> produces NO sibling .pdb but does emit an
#     EmbeddedPortablePdb entry in the debug directory.
#   * <DebugType>none</DebugType> produces neither.
# Run as part of the SDK smoke-test set alongside sdk-e2e.sh.
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
rm -rf "$HOME/.nuget/packages/gsharp.net.sdk/$VER" || true

WORK="$(mktemp -d -t gs-debug-e2e-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "==> Workspace: $WORK"

cat > "$WORK/global.json" <<EOF
{
  "msbuild-sdks": {
    "Gsharp.NET.Sdk": "$VER"
  }
}
EOF

cat > "$WORK/NuGet.config" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="local" value="$ROOT/.nugs" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
EOF

cat > "$WORK/Debuggable.gs" <<'EOF'
package debuggable

public func Add(a int32, b int32) int32 {
    var sum = a + b
    return sum
}
EOF

build_case() {
    local label="$1" debugType="$2"
    local dir="$WORK/$label"
    mkdir -p "$dir"
    cp "$WORK/Debuggable.gs" "$dir/Debuggable.gs"
    cp "$WORK/global.json" "$dir/global.json"
    cp "$WORK/NuGet.config" "$dir/NuGet.config"
    cat > "$dir/Debuggable.gsproj" <<EOF
<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <DebugType>$debugType</DebugType>
  </PropertyGroup>
</Project>
EOF
    echo "==> [$label] dotnet build --nologo (DebugType=$debugType)"
    dotnet build "$dir/Debuggable.gsproj" --nologo -v:q
}

build_case portable portable
build_case embedded embedded
build_case none     none

PORTABLE_DLL="$WORK/portable/bin/Debug/net10.0/Debuggable.dll"
PORTABLE_PDB="$WORK/portable/bin/Debug/net10.0/Debuggable.pdb"
EMBEDDED_DLL="$WORK/embedded/bin/Debug/net10.0/Debuggable.dll"
EMBEDDED_PDB="$WORK/embedded/bin/Debug/net10.0/Debuggable.pdb"
NONE_DLL="$WORK/none/bin/Debug/net10.0/Debuggable.dll"
NONE_PDB="$WORK/none/bin/Debug/net10.0/Debuggable.pdb"

if [[ ! -f "$PORTABLE_PDB" ]]; then
    echo "FAIL: portable build did not produce $PORTABLE_PDB"
    exit 1
fi
if [[ -f "$EMBEDDED_PDB" ]]; then
    echo "FAIL: embedded build unexpectedly produced sidecar $EMBEDDED_PDB"
    exit 1
fi
if [[ -f "$NONE_PDB" ]]; then
    echo "FAIL: DebugType=none build unexpectedly produced sidecar $NONE_PDB"
    exit 1
fi

# Verify each PE's debug directory shape via a tiny helper program.
HELPER="$WORK/inspect.csproj"
cat > "$HELPER" <<'EOF'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>disable</Nullable>
  </PropertyGroup>
</Project>
EOF
cat > "$WORK/Program.cs" <<'EOF'
using System;
using System.IO;
using System.Reflection.PortableExecutable;

var path = args[0];
using var stream = File.OpenRead(path);
using var pe = new PEReader(stream);
var entries = pe.ReadDebugDirectory();
bool hasCodeView = false, hasEmbedded = false, hasChecksum = false;
foreach (var e in entries)
{
    if (e.Type == DebugDirectoryEntryType.CodeView) hasCodeView = true;
    if (e.Type == DebugDirectoryEntryType.EmbeddedPortablePdb) hasEmbedded = true;
    if (e.Type == DebugDirectoryEntryType.PdbChecksum) hasChecksum = true;
}
Console.WriteLine($"codeview={hasCodeView} embedded={hasEmbedded} checksum={hasChecksum}");
EOF

mv "$HELPER" "$WORK/inspect/inspect.csproj" 2>/dev/null || { mkdir -p "$WORK/inspect"; mv "$HELPER" "$WORK/inspect/inspect.csproj"; }
mv "$WORK/Program.cs" "$WORK/inspect/Program.cs"
dotnet build "$WORK/inspect/inspect.csproj" -c Release --nologo -v:q >/dev/null

inspect() {
    dotnet "$WORK/inspect/bin/Release/net10.0/inspect.dll" "$1"
}

PORTABLE_INFO=$(inspect "$PORTABLE_DLL")
EMBEDDED_INFO=$(inspect "$EMBEDDED_DLL")
NONE_INFO=$(inspect "$NONE_DLL")

echo "portable: $PORTABLE_INFO"
echo "embedded: $EMBEDDED_INFO"
echo "none:     $NONE_INFO"

[[ "$PORTABLE_INFO" == "codeview=True embedded=False checksum=True" ]] || {
    echo "FAIL: portable PE debug directory mismatch"; exit 1; }
[[ "$EMBEDDED_INFO" == "codeview=True embedded=True checksum=True" ]] || {
    echo "FAIL: embedded PE debug directory mismatch"; exit 1; }
[[ "$NONE_INFO" == "codeview=False embedded=False checksum=False" ]] || {
    echo "FAIL: DebugType=none PE unexpectedly contains PDB debug directory entries"; exit 1; }

echo "PASS: debug-info end-to-end SDK build produces the expected sidecar/embedded/none shapes."
