#!/usr/bin/env bash
# Phase 9 acceptance: live-debugger end-to-end (#95, #50).
#
# Drives `netcoredbg --interpreter=mi` against a GSharp library called from
# a C# host. Sets a breakpoint by file+line inside the GSharp source,
# verifies it hits, lists locals (exercising LocalScope/LocalVariable from
# Phase 5), and steps through GSharp source.
#
# The script SKIPS cleanly (exit 0) for local developers when netcoredbg is
# unavailable, but treats absence as fatal in CI so debugger coverage cannot
# silently disappear. Local devs can install
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
    message="netcoredbg not installed (install from https://github.com/Samsung/netcoredbg/releases and place on PATH or in $TOOLS_DIR/netcoredbg/)"
    if [[ "${CI:-}" == "true" ]]; then
        echo "::error::$message" >&2
        exit 1
    fi
    skip "$message"
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

WORK_ROOT="${DBG_WORK_ROOT:-$ROOT/.e2e-work/debugger}"
mkdir -p "$WORK_ROOT"
WORK="$(mktemp -d "$WORK_ROOT/gs-dbg-e2e-XXXXXX")"
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

# Keep generated end-user projects isolated from this repo's Directory.Build.*
# conventions when the workspace is inside the checkout.
cat > "$WORK/Directory.Build.props" <<'EOF'
<Project />
EOF
cat > "$WORK/Directory.Build.targets" <<'EOF'
<Project />
EOF

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
    <Optimize>false</Optimize>
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

# Line of interest: line 6 (`var sum = a + b`). netcoredbg does not bind
# GSharp file:line breakpoints before the library is loaded, but a method
# breakpoint resolves to this sequence point and still verifies source mapping.
GS_BREAK_LINE=6
GS_BREAK_FUNCTION='GsLib.<Program>.Add'
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
#    - inserts a breakpoint in GsLib.Add, which resolves to Lib.gs:GS_BREAK_LINE
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
    echo "-interpreter-exec console \"set just-my-code 0\""
    echo "-break-insert -f $GS_BREAK_FUNCTION"
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

# Query the stopped state: locals + stack, remove the method breakpoint, then
# continue and exit. netcoredbg supports -stack-list-variables for locals.
if [[ $HIT -eq 1 ]]; then
    {
        echo "-stack-list-frames"
        echo "-stack-list-variables --all-values"
        echo "-break-delete 1"
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
if ! grep -q "line=\"$GS_BREAK_LINE\"" "$LOG"; then
    echo "FAIL: breakpoint hit was not on Lib.gs:$GS_BREAK_LINE"
    echo "----- log -----"
    cat "$LOG"
    exit 1
fi
for LOCAL in a b sum; do
    if ! grep -q "name=\"$LOCAL\"" "$LOG"; then
        echo "FAIL: debugger locals did not include '$LOCAL'"
        echo "----- log -----"
        cat "$LOG"
        exit 1
    fi
done
if ! grep -q "result=7" "$LOG"; then
    echo "FAIL: program did not complete (expected 'result=7' in output)"
    echo "----- log -----"
    cat "$LOG"
    exit 1
fi

echo "==> netcoredbg session summary"
grep -E "breakpoint-hit|stack-list-variables|variables=|name=\"a\"|name=\"b\"|name=\"sum\"|result=7" "$LOG" | head -20 || true

echo "PASS: netcoredbg hit $GS_BREAK_FUNCTION at Lib.gs line $GS_BREAK_LINE — the SDK-produced Portable PDB drives a cross-language live debugger end-to-end."

# ---------------------------------------------------------------------------
# ADR-0174 P3-8 — the debugging gate for inferred suspension. A plain `func`
# that receives from a channel is compiled as a suspending state machine;
# the debugger must still (a) bind a file:line breakpoint inside its body,
# (b) stop there with the G# source location, and (c) `-exec-next` across the
# receive onto the next source line — driven by the Portable PDB's
# async-method-stepping blob and the [AsyncStateMachine] kickoff attribute.
# ---------------------------------------------------------------------------
echo "==> ADR-0174: stepping through an inferred-suspending function"
mkdir -p "$WORK/lib2"
cp "$WORK/lib/global.json" "$WORK/lib/NuGet.config" "$WORK/lib2/"
cat > "$WORK/lib2/Lib2.gsproj" <<EOF2
<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <DebugType>portable</DebugType>
    <Optimize>false</Optimize>
    <AssemblyName>GsLib2</AssemblyName>
  </PropertyGroup>
</Project>
EOF2
cat > "$WORK/lib2/Lib2.gs" <<'EOF2'
package GsLib2
import System
public func Pipe() int32 {
    let ch = chan[int32](1)
    ch <- 20
    let v = <-ch
    var sum = v + 1
    return sum
}
EOF2
ASYNC_BREAK_LINE=6      # let v = <-ch
ASYNC_NEXT_LINE_1=7     # var sum = v + 1
ASYNC_NEXT_LINE_2=8     # return sum
mkdir -p "$WORK/host2"
cat > "$WORK/host2/Host2.csproj" <<EOF2
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>disable</Nullable>
    <DebugType>portable</DebugType>
    <DebugSymbols>true</DebugSymbols>
  </PropertyGroup>
</Project>
EOF2
cat > "$WORK/host2/Program.cs" <<'EOF2'
using System;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
public static class Program
{
    public static int Main()
    {
        var appDir = AppContext.BaseDirectory;
        var asm = Assembly.LoadFrom(Path.Combine(appDir, "GsLib2.dll"));
        var prog = asm.GetType("GsLib2.<Program>")!;
        var pipe = prog.GetMethod("Pipe", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;
        // An inferred-suspending function returns ValueTask<int> and carries the
        // ADR-0174 D7 hidden `Context` as a trailing OPTIONAL parameter. A C#
        // caller compiled against it lets the compiler fill the default; a
        // reflection caller has to say so, because Invoke's default binder is
        // strict about arity. Passing Type.Missing under OptionalParamBinding is
        // exactly the "a caller that predates the parameter still binds" claim
        // the ABI makes (ADR-0174 errata 24), so this asserts it.
        var pending = pipe.Invoke(
            null,
            BindingFlags.OptionalParamBinding,
            binder: null,
            new object[] { Type.Missing },
            culture: null)!;
        var task = (Task<int>)pending.GetType().GetMethod("AsTask")!.Invoke(pending, null)!;
        var result = task.GetAwaiter().GetResult();
        Console.WriteLine($"pipe={result}");
        return result == 21 ? 0 : 1;
    }
}
EOF2
echo "==> dotnet build $WORK/lib2/Lib2.gsproj"
dotnet build "$WORK/lib2/Lib2.gsproj" --nologo -v:q
echo "==> dotnet build $WORK/host2/Host2.csproj"
dotnet build "$WORK/host2/Host2.csproj" --nologo -v:q
HOST2_BIN="$WORK/host2/bin/Debug/net10.0"
cp "$WORK/lib2/bin/Debug/net10.0/GsLib2.dll" "$HOST2_BIN/GsLib2.dll"
cp "$WORK/lib2/bin/Debug/net10.0/GsLib2.pdb" "$HOST2_BIN/GsLib2.pdb"
cp "$WORK/lib2/bin/Debug/net10.0/Gsharp.Runtime.Channels.dll" "$HOST2_BIN/Gsharp.Runtime.Channels.dll"
HOST2_EXE="$HOST2_BIN/Host2"
LOG2="$WORK/dbg2.log"
FIFO2="$WORK/dbg2.in"
mkfifo "$FIFO2"
exec 4<>"$FIFO2"
( "$NETCOREDBG" --interpreter=mi < "$FIFO2" ) > "$LOG2" 2>&1 &
DBG2_PID=$!
{
    echo "-file-exec-and-symbols $HOST2_EXE"
    echo "-interpreter-exec console \"set just-my-code 0\""
    echo "-break-insert -f Lib2.gs:$ASYNC_BREAK_LINE"
    echo "-exec-run"
} >&4

# Waits until the log holds at least $1 "*stopped" events (or the debuggee
# exits); prints the last one.
wait_for_stopped() {
    local want=$1 waited=0
    while kill -0 "$DBG2_PID" 2>/dev/null; do
        local have
        have=$(grep -c "^\*stopped" "$LOG2" 2>/dev/null || true)
        if [[ ${have:-0} -ge $want ]]; then
            grep "^\*stopped" "$LOG2" | sed -n "${want}p"
            return 0
        fi
        if grep -q '\*stopped,reason="exited' "$LOG2" 2>/dev/null; then
            return 1
        fi
        sleep 0.2
        waited=$((waited+1))
        if [[ $waited -ge 300 ]]; then  # ~60s
            return 1
        fi
    done
    return 1
}

fail2() {
    echo "FAIL: $*"
    echo "----- log -----"
    cat "$LOG2"
    kill "$DBG2_PID" 2>/dev/null || true
    exit 1
}

STOP_INDEX=0
HIT2=""
while :; do
    STOP_INDEX=$((STOP_INDEX+1))
    EVENT=$(wait_for_stopped "$STOP_INDEX") || fail2 "timed out waiting for the breakpoint inside the suspending function"
    if [[ "$EVENT" == *'reason="breakpoint-hit"'* ]]; then
        HIT2="$EVENT"
        break
    fi
    echo "-exec-continue" >&4
done
[[ "$HIT2" == *"Lib2.gs"* ]] || fail2 "breakpoint hit was not on Lib2.gs"
[[ "$HIT2" == *"line=\"$ASYNC_BREAK_LINE\""* ]] || fail2 "breakpoint hit was not on Lib2.gs:$ASYNC_BREAK_LINE"
echo "-stack-list-frames" >&4
sleep 1
echo "-exec-next" >&4
STOP_INDEX=$((STOP_INDEX+1))
EVENT=$(wait_for_stopped "$STOP_INDEX") || fail2 "timed out stepping over the channel receive"
[[ "$EVENT" == *'reason="end-stepping-range"'* ]] || fail2 "step over the receive did not end a stepping range: $EVENT"
[[ "$EVENT" == *"line=\"$ASYNC_NEXT_LINE_1\""* ]] || fail2 "step over the receive did not land on Lib2.gs:$ASYNC_NEXT_LINE_1: $EVENT"
echo "-exec-next" >&4
STOP_INDEX=$((STOP_INDEX+1))
EVENT=$(wait_for_stopped "$STOP_INDEX") || fail2 "timed out stepping to the return"
[[ "$EVENT" == *"line=\"$ASYNC_NEXT_LINE_2\""* ]] || fail2 "second step did not land on Lib2.gs:$ASYNC_NEXT_LINE_2: $EVENT"
echo "-break-delete 1" >&4
echo "-exec-continue" >&4
WAIT=0
while kill -0 "$DBG2_PID" 2>/dev/null; do
    if grep -q '\*stopped,reason="exited' "$LOG2" 2>/dev/null || grep -q "pipe=21" "$LOG2" 2>/dev/null; then
        break
    fi
    sleep 0.2
    WAIT=$((WAIT+1))
    if [[ $WAIT -ge 150 ]]; then
        break
    fi
done
echo "-gdb-exit" >&4 2>/dev/null || true
exec 4>&-
wait "$DBG2_PID" 2>/dev/null || true
grep -q "pipe=21" "$LOG2" || fail2 "program did not complete (expected 'pipe=21' in output)"
echo "==> netcoredbg async session summary"
grep -E "breakpoint-hit|end-stepping-range|func=|pipe=21" "$LOG2" | head -12 || true
echo "PASS: netcoredbg stopped inside the inferred-suspending GsLib2.Pipe at Lib2.gs:$ASYNC_BREAK_LINE and stepped over the channel receive onto lines $ASYNC_NEXT_LINE_1 and $ASYNC_NEXT_LINE_2 (ADR-0174 P3-8)."
