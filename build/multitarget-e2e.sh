#!/usr/bin/env bash
# Validates that Gsharp.NET.Sdk produces a runnable assembly for every TFM
# we claim to support. Walks each TFM in TARGET_FRAMEWORKS, rebuilds the
# HelloWorld sample against it, runs the produced binary, and asserts the
# expected stdout. Used by p6-multitarget to gate cross-TFM regressions.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET_FRAMEWORKS=( "net8.0" "net10.0" )
EXPECTED="Hello, world!"

echo "==> Packing Gsharp.NET.Sdk into out/bin/Release/nupkgs"
dotnet build src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.csproj -c Release --nologo -v:q

NUPKG=$(ls -t out/bin/Release/nupkgs/Gsharp.NET.Sdk.*.nupkg | head -1)
VER="${NUPKG##*Gsharp.NET.Sdk.}"
VER="${VER%.nupkg}"
echo "    SDK version: $VER"

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

# Preserve the original gsproj so we can restore it on exit.
GSPROJ=samples/HelloWorld/HelloWorld.gsproj
cp "$GSPROJ" "$GSPROJ.bak"
trap 'mv "$GSPROJ.bak" "$GSPROJ"' EXIT

for tfm in "${TARGET_FRAMEWORKS[@]}"; do
    # Skip TFMs without an installed runtime — they can't be executed locally.
    # TFM "net8.0" maps to a runtime line starting with "Microsoft.NETCore.App 8.".
    major="${tfm#net}"
    major="${major%%.*}"
    if ! dotnet --list-runtimes | grep -qE "^Microsoft\.NETCore\.App ${major}\."; then
        echo "==> [$tfm] runtime not installed; skipping"
        continue
    fi

    echo "==> [$tfm] dotnet build samples/HelloWorld"
    rm -rf samples/HelloWorld/bin samples/HelloWorld/obj
    sed "s|<TargetFramework>net10.0</TargetFramework>|<TargetFramework>$tfm</TargetFramework>|" "$GSPROJ.bak" > "$GSPROJ"
    dotnet build "$GSPROJ" --nologo -v:q

    OUT="samples/HelloWorld/bin/Debug/$tfm/HelloWorld.dll"
    echo "==> [$tfm] dotnet $OUT"
    ACTUAL=$(dotnet "$OUT")
    if [[ "$ACTUAL" != "$EXPECTED" ]]; then
        echo "FAIL [$tfm]: expected '$EXPECTED', got '$ACTUAL'"
        exit 1
    fi
    echo "    PASS [$tfm]"
done

echo "PASS: all installed target frameworks produced runnable assemblies."
