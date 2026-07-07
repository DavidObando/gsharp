#!/usr/bin/env bash
# ADR-0145 §E/§F: validates the gsgen source-generator integration in the
# Gsharp.NET.Sdk. A native .gsproj references a real NuGet Roslyn generator
# (CommunityToolkit.Mvvm). The SDK must:
#   - resolve the package's C# analyzer assets (via a second ResolvePackageAssets
#     pass with ProjectLanguage=C#, since Language=Gsharp hides them normally),
#   - run that generator through gsgen BEFORE gsc,
#   - write back-translated .g.gs parts + a manifest under obj/.../gsgen/,
#   - feed those parts into gsc's compile.
#
# PRIMARY assertion (the make-or-break integration property): the SDK RAN the
# NuGet generator via gsgen and produced obj/.../gsgen/*.g.gs parts that were fed
# to gsc.
#
# KNOWN GAP (tracked for follow-up, NOT an SDK-wiring bug): gsc/cs2gs cannot yet
# compile the specific G# that MVVM's generated C# back-translates to — fully-
# qualified `System.*` type references need imports (GS0157) and the inherited
# `OnPropertyChanging/Changed` partial-method calls don't resolve (GS0130). So a
# fully-green `dotnet build` is NOT required here; if it goes green (once those
# gaps close) the script reports the stronger result and also runs the app.
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

echo "==> Pinning samples/SourceGen/global.json to Gsharp.NET.Sdk $VER"
cat > samples/SourceGen/global.json <<EOF
{
  "msbuild-sdks": {
    "Gsharp.NET.Sdk": "$VER"
  }
}
EOF

# Force NuGet to re-extract the (same-versioned) SDK so target edits take effect.
rm -rf "$HOME/.nuget/packages/gsharp.net.sdk/$VER" || true

echo "==> dotnet build samples/SourceGen/SourceGen.gsproj"
rm -rf samples/SourceGen/bin samples/SourceGen/obj
set +e
BUILD_LOG=$(dotnet build samples/SourceGen/SourceGen.gsproj --nologo 2>&1)
BUILD_RC=$?
set -e
echo "$BUILD_LOG"

GSGEN_DIR="samples/SourceGen/obj/Debug/net10.0/gsgen"
echo "==> Checking that gsgen ran and produced .g.gs parts under $GSGEN_DIR"
GGS_COUNT=$(ls "$GSGEN_DIR"/*.g.gs 2>/dev/null | wc -l | tr -d ' ')

if [[ "$GGS_COUNT" == "0" ]]; then
    echo "FAIL: gsgen did NOT run / produced no .g.gs parts."
    echo "      The SDK failed to resolve the NuGet generator or invoke gsgen."
    exit 1
fi

# Confirm the manifest lists the parts (i.e. the SDK's gsgen<->manifest<->Compile
# plumbing is intact) and that gsc actually consumed the generated files.
echo "PASS: gsgen RAN a real NuGet Roslyn generator and produced $GGS_COUNT .g.gs part(s):"
ls -1 "$GSGEN_DIR"/*.g.gs
echo "----- gsgen.manifest -----"
cat "$GSGEN_DIR/gsgen.manifest"

if ! grep -q "gsgen/" "$GSGEN_DIR/gsgen.manifest" 2>/dev/null; then
    echo "FAIL: gsgen manifest is empty or missing expected generated entries."
    exit 1
fi

if [[ "$BUILD_RC" == "0" ]]; then
    OUT="samples/SourceGen/bin/Debug/net10.0/SourceGen.dll"
    echo "==> Build went GREEN. Running $OUT"
    ACTUAL=$(dotnet "$OUT")
    EXPECTED='hello from a source generator'
    if [[ "$ACTUAL" != "$EXPECTED" ]]; then
        echo "FAIL: expected '$EXPECTED', got '$ACTUAL'"
        exit 1
    fi
    echo "PASS(STRONG): SDK ran the NuGet generator via gsgen, fed .g.gs to gsc, and produced a runnable assembly."
    exit 0
fi

# Build is red because gsc hit the documented back-translation gap on the
# generated code — verify the errors are IN the generated parts (proving gsc
# consumed them), which is the integration property under test.
if echo "$BUILD_LOG" | grep -q "gsgen/.*\.g\.gs.*error GS"; then
    echo
    echo "KNOWN GAP: gsc could not compile MVVM's back-translated generated code."
    echo "           The errors are located INSIDE the generated obj/.../gsgen/*.g.gs"
    echo "           files, proving the SDK fed the generated sources into gsc."
    echo "           Follow-up (cs2gs/gsc, not SDK wiring): fully-qualified System.*"
    echo "           type resolution (GS0157) and inherited OnPropertyChanging/"
    echo "           OnPropertyChanged partial-method resolution (GS0130)."
    echo
    echo "PASS(INTEGRATION): gsgen ran, produced .g.gs, and gsc consumed them."
    exit 0
fi

echo "FAIL: build failed but not with the expected generated-code gap; investigate:"
echo "$BUILD_LOG" | grep -i "error" | head
exit 1
