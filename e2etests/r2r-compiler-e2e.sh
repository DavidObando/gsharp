#!/usr/bin/env bash
# ADR-0207 / issue #5155: the ReadyToRun compiler packages (Gsharp.NET.Sdk.Compiler.<rid>).
# Builds a project through the REAL packed Gsharp.NET.Sdk with an empty NuGet cache and checks that:
#   - restore fetched only the package of the host RID, and the build used its gsc;
#   - the build output equals the output of the portable IL gsc (GsharpUseReadyToRunCompiler=false);
#   - a source-generator build (gsgen) works while the ReadyToRun gsc is selected;
#   - a direct call of the package gsc copies the portable runtime file when GSHARP_SDK_TOOLS_DIR is
#     set, and copies nothing when it is not;
#   - the SDK and the RID package can sit in different package roots (restore --packages).
# On a host RID outside the six (for example linux-musl-x64) it checks that the IL compiler is used.
#
# Packages: when GSHARP_R2R_NUPKG_DIR names a folder with the nupkgs of one build (the CI smoke on
# each OS does this with the artifact built on Linux), those are used. Otherwise the script builds them.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

native() {
    if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi
}
sha() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
fail() { echo "FAIL: $*" >&2; exit 1; }
machine() {
    # The PE Machine field, as hex: the file offset of the PE header is at 0x3C.
    local file="$1" off
    off=$(od -An -tu4 -j60 -N4 "$file" | tr -d ' ')
    od -An -tx2 -j$((off + 4)) -N2 "$file" | tr -d ' '
}

if [[ -n "${GSHARP_R2R_NUPKG_DIR:-}" ]]; then
    PKGS="$GSHARP_R2R_NUPKG_DIR"
else
    echo "==> Packing Gsharp.NET.Sdk and the Gsharp.NET.Sdk.Compiler.<rid> packages"
    dotnet build src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj -c Release --nologo -v:q
    PKGS="out/bin/Release/nupkgs"
fi

NUPKG=$(ls -t "$PKGS"/Gsharp.NET.Sdk.[0-9]*.nupkg | head -1)
VER="${NUPKG##*Gsharp.NET.Sdk.}"
VER="${VER%.nupkg}"
RID=$(dotnet --info | sed -n 's/^ *RID: *//p' | head -1 | tr -d '\r')
echo "SDK version $VER, host RID $RID"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FEED="$WORK/feed"
mkdir -p "$FEED"
cp "$PKGS"/Gsharp.NET.Sdk."$VER".nupkg "$FEED"/
for pkg in "$PKGS"/Gsharp.NET.Sdk.Compiler.*."$VER".nupkg; do cp "$pkg" "$FEED"/; done
[[ $(ls "$FEED"/Gsharp.NET.Sdk.Compiler.*.nupkg | wc -l) -eq 6 ]] || fail "expected six Gsharp.NET.Sdk.Compiler.<rid> packages for $VER"

SIX=" linux-x64 linux-arm64 win-x64 win-arm64 osx-x64 osx-arm64 "
if [[ "$SIX" == *" $RID "* ]]; then EXPECT=r2r; else EXPECT=il; fi

write_project_files() {
    local dir="$1"
    mkdir -p "$dir"
    cat > "$dir/nuget.config" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="local" value="$(native "$FEED")" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
EOF
    cat > "$dir/global.json" <<EOF
{
  "msbuild-sdks": {
    "Gsharp.NET.Sdk": "$VER"
  }
}
EOF
}

APP="$WORK/app"
write_project_files "$APP"
cat > "$APP/App.gsproj" <<'EOF'
<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
EOF
cp samples/Channels.gs "$APP/Program.gs"

export NUGET_PACKAGES="$(native "$WORK/pk")"
export MSBUILDDISABLENODEREUSE=1
PK="$WORK/pk"

echo "==> Build 1: default compiler selection, empty NuGet cache"
LOG=$(cd "$APP" && dotnet build App.gsproj --nologo -v:n 2>&1) || { echo "$LOG"; fail "build 1 failed"; }
if [[ "$EXPECT" == r2r ]]; then
    echo "$LOG" | grep -q "G# compiler: ReadyToRun $RID from .*gsharp.net.sdk.compiler.$RID" \
        || { echo "$LOG" | grep "G# compiler:" || true; fail "the ReadyToRun compiler of $RID was not selected"; }
    PACKS=$(ls "$PK" | grep -c '^gsharp\.net\.sdk\.compiler\.' || true)
    [[ "$PACKS" -eq 1 && -d "$PK/gsharp.net.sdk.compiler.$RID" ]] \
        || { ls "$PK"; fail "restore must fetch only the host RID package ($RID)"; }
else
    echo "$LOG" | grep -q "G# compiler: IL from" || fail "host RID $RID is outside the six: the IL compiler must be used"
    [[ $(ls "$PK" | grep -c '^gsharp\.net\.sdk\.compiler\.' || true) -eq 0 ]] || fail "no RID package may be restored for $RID"
fi
APP_OUT="$APP/bin/Debug/net10.0"
(cd "$APP" && dotnet bin/Debug/net10.0/App.dll) | tr -d '\r' > "$WORK/run1.txt"
diff <(tr -d '\r' < samples/Channels.golden) "$WORK/run1.txt" >/dev/null || fail "the program output differs from samples/Channels.golden"
HASH_R2R=$(sha "$APP_OUT/App.dll")

echo "==> Build 2: GsharpUseReadyToRunCompiler=false (IL compiler), same project path"
rm -rf "$APP/bin" "$APP/obj"
LOG2=$(cd "$APP" && dotnet build App.gsproj --nologo -v:n -p:GsharpUseReadyToRunCompiler=false 2>&1) || { echo "$LOG2"; fail "build 2 failed"; }
echo "$LOG2" | grep -q "G# compiler: IL from .* because GsharpUseReadyToRunCompiler is false" || fail "the opt-out did not select the IL compiler"
HASH_IL=$(sha "$APP_OUT/App.dll")
[[ "$HASH_R2R" == "$HASH_IL" ]] || fail "App.dll differs between the ReadyToRun gsc ($HASH_R2R) and the IL gsc ($HASH_IL)"
echo "App.dll is byte-identical: $HASH_R2R"

echo "==> Build 3: a source-generator build (gsgen) with the default compiler"
GEN="$WORK/gen"
write_project_files "$GEN"
cp -R samples/GeneratedRegex/. "$GEN"/
rm -rf "$GEN/bin" "$GEN/obj"
write_project_files "$GEN"
LOG3=$(cd "$GEN" && dotnet build GeneratedRegex.gsproj --nologo -v:n 2>&1) || { echo "$LOG3"; fail "the generator build failed"; }
[[ -n "$(ls "$GEN"/obj/Debug/net10.0/gsgen/*.g.gs 2>/dev/null)" ]] || fail "gsgen produced no .g.gs part"
if [[ "$EXPECT" == r2r ]]; then
    echo "$LOG3" | grep -q "G# compiler: ReadyToRun $RID" || fail "the generator build did not use the ReadyToRun compiler"
fi

if [[ "$EXPECT" == r2r ]]; then
    SDK_TOOLS="$PK/gsharp.net.sdk/$VER/tools"
    RID_GSC="$PK/gsharp.net.sdk.compiler.$RID/$VER/tools/net10.0/$RID/gsc.dll"
    [[ -f "$RID_GSC" ]] || fail "missing $RID_GSC"
    PORTABLE="$SDK_TOOLS/channels/Gsharp.Runtime.Channels.dll"
    [[ "$(machine "$PORTABLE")" == "014c" ]] || fail "the SDK package copy of the channels runtime is not portable IL"
    [[ ! -f "$PK/gsharp.net.sdk.compiler.$RID/$VER/tools/net10.0/$RID/Gsharp.Runtime.Channels.dll" ]] \
        || fail "the RID package must not carry the portable runtime set"

    echo "==> Direct call of the package gsc"
    RSP=$(ls "$APP"/obj/Debug/net10.0/*.rsp | grep -v gsgen | head -1)
    for mode in with without; do
        OUTDIR="$WORK/direct-$mode"
        mkdir -p "$OUTDIR"
        # The SDK writes /sdktoolsdir: into the response file. Drop it, so that only the variable decides.
        grep -v '^/out:\|^/pdb:\|^/refout:\|^/doc:\|^/sourcelink:\|sdktoolsdir:' "$RSP" > "$WORK/direct-$mode.rsp"
        echo "/out:$(native "$OUTDIR")/App.dll" >> "$WORK/direct-$mode.rsp"
        if [[ "$mode" == with ]]; then
            (cd "$APP" && GSHARP_SDK_TOOLS_DIR="$(native "$SDK_TOOLS")" dotnet "$(native "$RID_GSC")" "@$(native "$WORK/direct-$mode.rsp")") >/dev/null \
                || fail "direct call with GSHARP_SDK_TOOLS_DIR failed"
            [[ -f "$OUTDIR/Gsharp.Runtime.Channels.dll" ]] || fail "the direct call did not copy the channels runtime"
            cmp -s "$OUTDIR/Gsharp.Runtime.Channels.dll" "$PORTABLE" || fail "the copied channels runtime differs from the SDK package copy"
            [[ "$(machine "$OUTDIR/Gsharp.Runtime.Channels.dll")" == "014c" ]] || fail "the copied channels runtime is not portable IL"
        else
            (cd "$APP" && env -u GSHARP_SDK_TOOLS_DIR dotnet "$(native "$RID_GSC")" "@$(native "$WORK/direct-$mode.rsp")") >/dev/null \
                || fail "direct call without GSHARP_SDK_TOOLS_DIR failed"
            [[ ! -f "$OUTDIR/Gsharp.Runtime.Channels.dll" ]] || fail "the direct call copied a runtime file without being given the SDK tools folder"
        fi
    done

    echo "==> Split roots: the SDK package and the RID package in different package roots"
    SPLIT="$WORK/split"
    write_project_files "$SPLIT"
    cp "$APP/App.gsproj" "$SPLIT/App.gsproj"
    cp samples/Channels.gs "$SPLIT/Program.gs"
    (cd "$SPLIT" && dotnet restore App.gsproj --nologo -v:q --packages "$(native "$WORK/pk2")") >/dev/null || fail "split-root restore failed"
    [[ -d "$WORK/pk2/gsharp.net.sdk.compiler.$RID" && ! -d "$WORK/pk2/gsharp.net.sdk" ]] \
        || { ls "$WORK/pk2"; fail "the RID package must be in the project package root and the SDK in the global root"; }
    LOG4=$(cd "$SPLIT" && dotnet build App.gsproj --no-restore --nologo -v:n 2>&1) || { echo "$LOG4"; fail "split-root build failed"; }
    # Windows logs paths with backslashes.
    echo "$LOG4" | tr '\\' '/' | grep -q "G# compiler: ReadyToRun $RID from .*pk2/gsharp.net.sdk.compiler.$RID" || { echo "$LOG4" | grep "G# compiler:" || true; fail "the split-root build did not use the RID package from the project package root"; }
    [[ -f "$SPLIT/bin/Debug/net10.0/Gsharp.Runtime.Channels.dll" ]] || fail "the split-root build did not put the channels runtime in the output"
    cmp -s "$SPLIT/bin/Debug/net10.0/Gsharp.Runtime.Channels.dll" "$PORTABLE" || fail "the split-root runtime differs from the SDK package copy"
fi

echo "==> Opt-out in the project file: restore must not ask for a RID package"
# The property is set in the project body, after the SDK props are imported. A feed without the RID
# packages and an empty package cache must still restore, because no PackageDownload is requested.
OPT="$WORK/optout"
write_project_files "$OPT"
rm -rf "$WORK/feed-no-rid"
mkdir -p "$WORK/feed-no-rid"
cp "$PKGS"/Gsharp.NET.Sdk."$VER".nupkg "$WORK/feed-no-rid"/
sed -i.bak "s#$(native "$FEED")#$(native "$WORK/feed-no-rid")#" "$OPT/nuget.config"
rm -f "$OPT/nuget.config.bak"
cat > "$OPT/App.gsproj" <<'EOF'
<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <GsharpUseReadyToRunCompiler>false</GsharpUseReadyToRunCompiler>
  </PropertyGroup>
</Project>
EOF
cp samples/Channels.gs "$OPT/Program.gs"
LOG5=$(cd "$OPT" && NUGET_PACKAGES="$(native "$WORK/pk3")" dotnet build App.gsproj --nologo -v:n 2>&1) || { echo "$LOG5" | tail -20; fail "the project-file opt-out build failed"; }
echo "$LOG5" | grep -q "G# compiler: IL from .* because GsharpUseReadyToRunCompiler is false" || fail "the project-file opt-out did not select the IL compiler"
[[ $(ls "$WORK/pk3" | grep -c '^gsharp\.net\.sdk\.compiler\.' || true) -eq 0 ]] || fail "the project-file opt-out still restored a RID package"

echo "PASS: r2r-compiler-e2e ($RID, $EXPECT)"
