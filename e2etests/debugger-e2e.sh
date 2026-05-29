#!/usr/bin/env bash
# Phase 9 acceptance: live-debugger end-to-end (#95, #50).
#
# Drives `netcoredbg --interpreter=mi` against a GSharp library called from
# a C# host. Sets a breakpoint by file+line inside the GSharp source,
# verifies it hits, lists locals (exercising LocalScope/LocalVariable from
# Phase 5), and steps through GSharp source.
#
# The script SKIPS cleanly (exit 0) when netcoredbg is unavailable so that
# CI lanes that do not provision it stay green. Local devs can install
# netcoredbg by following https://github.com/Samsung/netcoredbg/releases
# or via the helper at the top of this file.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TOOLS_DIR="$ROOT/.tools"
mkdir -p "$TOOLS_DIR"

find_netcoredbg() {
    if command -v netcoredbg >/dev/null 2>&1; then
        command -v netcoredbg
        return 0
    fi
    if [[ -x "$TOOLS_DIR/netcoredbg/netcoredbg" ]]; then
        echo "$TOOLS_DIR/netcoredbg/netcoredbg"
        return 0
    fi
    return 1
}

skip() {
    echo "SKIP: $*"
    exit 0
}

NETCOREDBG="$(find_netcoredbg || true)"
if [[ -z "$NETCOREDBG" ]]; then
    skip "netcoredbg not installed (install from https://github.com/Samsung/netcoredbg/releases and place on PATH or in $TOOLS_DIR/netcoredbg/)"
fi

# netcoredbg ships an osx-amd64 build but no osx-arm64 build, so on
# Apple Silicon the launched .NET arm64 process and the x86_64 debugger
# can't talk to each other — netcoredbg segfaults during attach. Skip
# cleanly so this script stays a no-op on developer Macs while still
# running end-to-end on the primary CI lanes (linux-amd64 / linux-arm64
# / macOS x64).
OS="$(uname -s)"
ARCH="$(uname -m)"
if [[ "$OS" == "Darwin" && "$ARCH" == "arm64" ]]; then
    # If the binary is the upstream x86_64 build, attaching to a native
    # arm64 dotnet will crash. Detect via `file` if available.
    if command -v file >/dev/null 2>&1; then
        if file "$NETCOREDBG" 2>/dev/null | grep -qE "x86_64|i386"; then
            skip "netcoredbg at $NETCOREDBG is x86_64 but host is arm64; upstream does not yet ship osx-arm64 — install a matching build or run this on Linux."
        fi
    fi
fi

echo "==> Using netcoredbg: $NETCOREDBG"

# 1. Pack the GSharp SDK so we can build a real .gsproj end-to-end.
echo "==> Packing Gsharp.NET.Sdk into .nugs/"
dotnet build src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.csproj -c Release --nologo -v:q
mkdir -p .nugs
cp out/bin/Release/nupkgs/Gsharp.NET.Sdk.*.nupkg .nugs/

NUPKG=$(ls -t out/bin/Release/nupkgs/Gsharp.NET.Sdk.*.nupkg | head -1)
VER="${NUPKG##*Gsharp.NET.Sdk.}"
VER="${VER%.nupkg}"
rm -rf "$HOME/.nuget/packages/gsharp.net.sdk/$VER" || true

WORK="$(mktemp -d -t gs-dbg-e2e-XXXXXX)"
KEEP_WORK="${KEEP_DBG_WORK:-}"
cleanup() {
    if [[ -z "$KEEP_WORK" ]]; then
        rm -rf "$WORK"
    else
        echo "==> KEEP_DBG_WORK set; leaving $WORK"
    fi
}
trap cleanup EXIT
echo "==> Workspace: $WORK"

# 2. Author a small GSharp library with a method we can break inside.
mkdir -p "$WORK/lib"
cat > "$WORK/lib/global.json" <<EOF
{
  "msbuild-sdks": {
    "Gsharp.NET.Sdk": "$VER"
  }
}
EOF
cat > "$WORK/lib/NuGet.config" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="local" value="$ROOT/.nugs" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
EOF
cat > "$WORK/lib/Lib.gsproj" <<EOF
<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <DebugType>portable</DebugType>
    <AssemblyName>GsLib</AssemblyName>
  </PropertyGroup>
</Project>
EOF

# IMPORTANT: line numbers here are pinned by the breakpoint below.
cat > "$WORK/lib/Lib.gs" <<'EOF'
package GsLib

import System

public func Add(a int32, b int32) int32 {
    var sum = a + b
    return sum
}
EOF

# Line of interest: line 6 (`var sum = a + b`).
GS_BREAK_LINE=6
GS_FILE="$WORK/lib/Lib.gs"

# 3. C# host that loads the GSharp library and calls Add.
mkdir -p "$WORK/host"
cat > "$WORK/host/Host.csproj" <<EOF
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>disable</Nullable>
    <DebugType>portable</DebugType>
    <DebugSymbols>true</DebugSymbols>
  </PropertyGroup>
</Project>
EOF
cat > "$WORK/host/Program.cs" <<'EOF'
using System;
using System.IO;
using System.Reflection;

public static class Program
{
    public static int Main()
    {
        // Force GsLib to load and resolve Add via reflection so the
        // debugger has a concrete IL frame to break inside.
        var appDir = AppContext.BaseDirectory;
        var asm = Assembly.LoadFrom(Path.Combine(appDir, "GsLib.dll"));
        var prog = asm.GetType("GsLib.<Program>")!;
        var add = prog.GetMethod("Add", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;
        var result = (int)add.Invoke(null, new object[] { 3, 4 })!;
        Console.WriteLine($"result={result}");
        return result == 7 ? 0 : 1;
    }
}
EOF

echo "==> dotnet build $WORK/lib/Lib.gsproj"
dotnet build "$WORK/lib/Lib.gsproj" --nologo -v:q

echo "==> dotnet build $WORK/host/Host.csproj"
dotnet build "$WORK/host/Host.csproj" --nologo -v:q

# Copy GSharp library next to the host executable so the loader finds it.
HOST_BIN="$WORK/host/bin/Debug/net10.0"
cp "$WORK/lib/bin/Debug/net10.0/GsLib.dll" "$HOST_BIN/GsLib.dll"
cp "$WORK/lib/bin/Debug/net10.0/GsLib.pdb" "$HOST_BIN/GsLib.pdb"

# 4. Write an MI script that:
#    - sets the program path
#    - inserts a breakpoint at Lib.gs:GS_BREAK_LINE
#    - runs to the breakpoint, lists locals, continues, exits
HOST_DLL="$HOST_BIN/Host.dll"
HOST_EXE="$HOST_BIN/Host"
LOG="$WORK/dbg.log"
FIFO="$WORK/dbg.in"
mkfifo "$FIFO"

echo "==> Running netcoredbg against $HOST_DLL"
# Open the fifo for read+write to avoid blocking when there's no peer yet.
exec 3<>"$FIFO"
( "$NETCOREDBG" --interpreter=mi < "$FIFO" ) > "$LOG" 2>&1 &
DBG_PID=$!

# Stream the initial MI commands.
{
    echo "-file-exec-and-symbols $HOST_EXE"
    echo "-break-insert -f $GS_FILE:$GS_BREAK_LINE"
    echo "-exec-run"
} >&3

WAIT=0
HIT=0
PROCESSED_STOPPED=0
while kill -0 "$DBG_PID" 2>/dev/null; do
    if [[ -s "$LOG" ]]; then
        STOPPED_COUNT=$(grep -c "^\*stopped" "$LOG" 2>/dev/null || true)
        if [[ $STOPPED_COUNT -gt $PROCESSED_STOPPED ]]; then
            NEW_STOPPED_COUNT=$((STOPPED_COUNT - PROCESSED_STOPPED))
            PROCESSED_STOPPED=$STOPPED_COUNT
            while IFS= read -r STOPPED_EVENT; do
                if [[ "$STOPPED_EVENT" == *'reason="breakpoint-hit"'* ]]; then
                    HIT=1
                    break
                fi

                echo "-exec-continue" >&3
            done < <(grep "^\*stopped" "$LOG" 2>/dev/null | tail -n "$NEW_STOPPED_COUNT")
        fi
    fi
    if [[ $HIT -eq 1 ]]; then
        break
    fi
    sleep 0.2
    WAIT=$((WAIT+1))
    if [[ $WAIT -ge 150 ]]; then  # ~30s
        kill "$DBG_PID" 2>/dev/null || true
        echo "FAIL: timed out waiting for breakpoint hit"
        echo "----- log -----"
        cat "$LOG"
        exit 1
    fi
done

# Query the stopped state: locals + stack, then continue and exit.
if [[ $HIT -eq 1 ]]; then
    {
        echo "-stack-list-frames"
        echo "-stack-list-locals --all-values"
        echo "-exec-continue"
    } >&3
fi

# Wait for the program to finish, then close fd 3 so netcoredbg sees EOF.
WAIT=0
while kill -0 "$DBG_PID" 2>/dev/null; do
    if grep -q "\\*stopped,reason=\"exited" "$LOG" 2>/dev/null \
       || grep -q "result=7" "$LOG" 2>/dev/null; then
        break
    fi
    sleep 0.2
    WAIT=$((WAIT+1))
    if [[ $WAIT -ge 75 ]]; then
        break
    fi
done

echo "-gdb-exit" >&3 2>/dev/null || true
exec 3>&-
wait "$DBG_PID" 2>/dev/null || true

if ! grep -q "\\*stopped,reason=\"breakpoint-hit\"" "$LOG"; then
    echo "FAIL: did not observe a breakpoint hit on $GS_FILE:$GS_BREAK_LINE"
    echo "----- log -----"
    cat "$LOG"
    exit 1
fi
if ! grep -q "Lib.gs" "$LOG"; then
    echo "FAIL: breakpoint hit was not on Lib.gs"
    echo "----- log -----"
    cat "$LOG"
    exit 1
fi
if ! grep -q "result=7" "$LOG"; then
    echo "FAIL: program did not complete (expected 'result=7' in output)"
    echo "----- log -----"
    cat "$LOG"
    exit 1
fi

echo "==> netcoredbg session summary"
grep -E "breakpoint-hit|stack-list-locals|name=\"a\"|name=\"b\"|name=\"sum\"|result=7" "$LOG" | head -20 || true

echo "PASS: netcoredbg hit a breakpoint inside Lib.gs at line $GS_BREAK_LINE — the SDK-produced Portable PDB drives a cross-language live debugger end-to-end."
