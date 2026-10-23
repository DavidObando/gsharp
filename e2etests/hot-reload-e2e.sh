#!/usr/bin/env bash
# Issue #3339: validates dotnet-watch project loading plus G# runtime deltas.
# Covers a local body edit, a transitive G# project, and an Avalonia-style
# generated C# source that must pass through gsgen before gsc.
# Issue #4960: every applied delta also runs the sample's MetadataUpdateHandler
# callbacks in the existing process, in dotnet watch's order.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SAMPLE="samples/HotReload"
APP="$SAMPLE/App/App.gsproj"
LOG="$SAMPLE/watch.log"
WATCH_PID=""

cleanup() {
    if [[ -n "$WATCH_PID" ]] && kill -0 "$WATCH_PID" 2>/dev/null; then
        kill "$WATCH_PID"
        wait "$WATCH_PID" 2>/dev/null || true
    fi

    git checkout -- \
        "$SAMPLE/global.json" \
        "$SAMPLE/App/App.gs" \
        "$SAMPLE/App/GeneratedValue.axaml" \
        "$SAMPLE/Base/Values.gs" 2>/dev/null || true
    rm -f "$LOG"
}
trap cleanup EXIT

wait_for() {
    local pattern="$1"
    local description="$2"
    local attempts=0

    while ! grep -q "$pattern" "$LOG" 2>/dev/null; do
        if ! kill -0 "$WATCH_PID" 2>/dev/null; then
            echo "FAIL: dotnet watch exited while waiting for $description"
            cat "$LOG"
            exit 1
        fi

        attempts=$((attempts + 1))
        if [[ $attempts -ge 600 ]]; then
            echo "FAIL: timed out waiting for $description"
            cat "$LOG"
            exit 1
        fi

        sleep 0.2
    done
}

wait_for_count() {
    local pattern="$1"
    local expected="$2"
    local description="$3"
    local attempts=0

    while [[ "$(grep -c "$pattern" "$LOG" 2>/dev/null || true)" -lt "$expected" ]]; do
        if ! kill -0 "$WATCH_PID" 2>/dev/null; then
            echo "FAIL: dotnet watch exited while waiting for $description"
            cat "$LOG"
            exit 1
        fi

        attempts=$((attempts + 1))
        if [[ $attempts -ge 600 ]]; then
            echo "FAIL: timed out waiting for $description"
            cat "$LOG"
            exit 1
        fi

        sleep 0.2
    done
}

# Replaces each BEFORE with its AFTER (once) in a single write, so the agent
# sees all of them in one delta.
replace_once() {
    local path="$1"
    shift
    python3 - "$path" "$@" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
pairs = sys.argv[2:]
text = path.read_text()
for before, after in zip(pairs[0::2], pairs[1::2]):
    if before not in text:
        raise SystemExit(f"missing expected text in {path}: {before}")
    text = text.replace(before, after, 1)
path.write_text(text)
PY
}

# Issue #4960: checks the metadata update handler output of the Nth applied
# delta. Each delta prints one block of five lines: the transitive Base
# handler's ClearCache before the app's handlers' (the failing one is
# registered first and throws), and every ClearCache before any
# UpdateApplication, all with the same updated types.
expect_handler_block() {
    local index="$1"
    local types="$2"
    local label="$3"
    python3 - "$LOG" "$index" "$types" "$label" <<'PY'
import re
import sys

log, index, types, label = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
lines = [m.group(0) for m in (re.search(r"handler=.*$", line) for line in open(log)) if m]
blocks = [lines[i:i + 5] for i in range(0, len(lines), 5)]
if len(blocks) < index:
    raise SystemExit(f"FAIL: expected at least {index} handler blocks, saw {len(blocks)}:\n" + "\n".join(lines))
block = blocks[index - 1]
if types == "*":
    match = re.match(r"handler=base phase=ClearCache types=(.+)$", block[0])
    if not match:
        raise SystemExit(f"FAIL: handler block {index} does not start with the Base ClearCache:\n" + "\n".join(block))
    types = match.group(1)
expected = [
    f"handler=base phase=ClearCache types={types}",
    "handler=failing phase=ClearCache",
    f"handler=app phase=ClearCache types={types}",
    f"handler=base phase=UpdateApplication types={types}",
    f"handler=app phase=UpdateApplication types={types} label={label}",
]
if block != expected:
    raise SystemExit(
        f"FAIL: handler block {index} is out of order or has the wrong types.\nexpected:\n"
        + "\n".join(expected)
        + "\nactual:\n"
        + "\n".join(block)
    )
print(f"handler block {index}: OK ({types})")
PY
}

echo "==> Packing Gsharp.NET.Sdk"
dotnet build src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj -c Release --nologo -v:q
mkdir -p .nugs
cp out/bin/Release/nupkgs/Gsharp.NET.Sdk.*.nupkg .nugs/

NUPKG=$(ls -t out/bin/Release/nupkgs/Gsharp.NET.Sdk.[0-9]*.nupkg | head -1)
VER="${NUPKG##*Gsharp.NET.Sdk.}"
VER="${VER%.nupkg}"

cat > "$SAMPLE/global.json" <<EOF
{
  "msbuild-sdks": {
    "Gsharp.NET.Sdk": "$VER"
  }
}
EOF

rm -rf "$HOME/.nuget/packages/gsharp.net.sdk/$VER" \
       "$SAMPLE/App/bin" "$SAMPLE/App/obj" \
       "$SAMPLE/Lib/bin" "$SAMPLE/Lib/obj" \
       "$SAMPLE/Base/bin" "$SAMPLE/Base/obj"

echo "==> Restoring hot-reload sample"
dotnet restore "$APP" --nologo

echo "==> Starting dotnet watch"
: > "$LOG"
dotnet watch --project "$APP" --no-restore --non-interactive >"$LOG" 2>&1 &
WATCH_PID=$!

wait_for "values=1,2,3" "initial application output"
wait_for "modifiable=debug" "modifiable debug process"
wait_for "watching '.*samples/HotReload/App/App.gsproj'" "App hot-reload agent"
wait_for "watching '.*samples/HotReload/Lib/Lib.gsproj'" "Lib hot-reload agent"
wait_for "watching '.*samples/HotReload/Base/Base.gsproj'" "transitive Base hot-reload agent"

GENERATED_CS="$SAMPLE/App/obj/Debug/net10.0/hotreload-generated/GeneratedLike.g.cs"
if [[ ! -f "$GENERATED_CS" ]] || ! grep -q "Current() => 3;" "$GENERATED_CS"; then
    echo "FAIL: Avalonia-style target did not materialize expected generated C#: $GENERATED_CS"
    cat "$LOG"
    exit 1
fi

echo "==> Applying local G# method-body edit"
replace_once "$SAMPLE/App/App.gs" "return 1" "return 11"
wait_for "values=11,2,3" "local G# delta"
wait_for_count "handler=app phase=UpdateApplication" 1 "metadata update handlers after the local delta"
# The first delta can also carry generated bootstrap methods, so only the
# order is pinned here.
expect_handler_block 1 "*" "label-a"

echo "==> Applying transitive project-reference method-body edit"
# Two types plus a nested type change in one delta: the handlers receive the
# top-level types in metadata order, then the nested type, each once.
replace_once "$SAMPLE/Base/Values.gs" "return 2" "return 22" '"label-a"' '"label-b"'
wait_for "values=11,22,3" "transitive project-reference delta"
wait_for_count "handler=app phase=UpdateApplication" 2 "metadata update handlers after the transitive delta"
expect_handler_block 2 "HotReloadBase.BaseValues,HotReloadBase.BaseLabel,HotReloadBase.BaseLabel+Inner" "label-b"

echo "==> Applying Avalonia-style generated-input edit"
replace_once "$SAMPLE/App/GeneratedValue.axaml" 'Value="3"' 'Value="33"'
wait_for "values=11,22,33" "generated gsgen delta"
wait_for_count "handler=app phase=UpdateApplication" 3 "metadata update handlers after the generated delta"
expect_handler_block 3 "HotReloadApp.GeneratedLike" "label-b"

FAILURE_COUNT=$(grep -c "GSHR1005: exception from 'HotReloadApp.FailingUpdateHandler.ClearCache': System.InvalidOperationException: handler-failure-probe" "$LOG" || true)
if [[ "$FAILURE_COUNT" -lt 3 ]]; then
    echo "FAIL: expected the failing handler's exception to be reported for each delta, saw $FAILURE_COUNT"
    cat "$LOG"
    exit 1
fi
if grep "GSHR1005" "$LOG" | grep -vq "handler-failure-probe"; then
    echo "FAIL: unexpected metadata update handler diagnostic:"
    grep "GSHR1005" "$LOG" | grep -v "handler-failure-probe"
    exit 1
fi

if grep -q "MSB4057" "$LOG"; then
    echo "FAIL: design-time project load still reports MSB4057"
    cat "$LOG"
    exit 1
fi

PID_COUNT=$(grep -o 'pid=[0-9][0-9]*' "$LOG" | sort -u | wc -l | tr -d ' ')
if [[ "$PID_COUNT" != "1" ]]; then
    echo "FAIL: process restarted instead of applying deltas (unique PIDs: $PID_COUNT)"
    cat "$LOG"
    exit 1
fi

if grep -Eq "dotnet watch .*File updated: .*\\.(gs|cs|axaml)" "$LOG"; then
    echo "FAIL: dotnet watch raced the G# agent on an agent-owned source:"
    grep -E "dotnet watch .*File updated:" "$LOG"
    exit 1
fi

if grep -q "Waiting for a file to change before restarting" "$LOG"; then
    echo "FAIL: dotnet watch restarted or queued a restart instead of leaving edits to the G# agent"
    cat "$LOG"
    exit 1
fi

APPLY_COUNT=$(grep -c "G# hot reload: applied" "$LOG" || true)
if [[ "$APPLY_COUNT" -lt 3 ]]; then
    echo "FAIL: expected at least three applied G# deltas, saw $APPLY_COUNT"
    cat "$LOG"
    exit 1
fi

# ADR-0174 P3-9: an edit that makes a plain func suspend (a channel receive
# appears in its body) changes the method's compiled shape, so the agent must
# reject it explicitly as GSHR1002 rather than apply a broken delta or restart
# on its own. The edit compiles (an unbounded channel receive) but is never
# run: the rejected candidate leaves the old body in place.
echo "==> Applying a suspension-flipping edit (expects GSHR1002, no restart)"
replace_once "$SAMPLE/App/App.gs" "return 11" "return <-Chan.Unbounded[int32]()"
wait_for "GSHR1002" "suspension-flip restart diagnostic"
if ! grep -q "GSHR1002: method 'HotReloadApp.<Program>.LocalValue' changed suspension" "$LOG"; then
    echo "FAIL: GSHR1002 did not name the function whose suspension changed"
    grep "GSHR1002" "$LOG" || true
    exit 1
fi
PID_COUNT_AFTER=$(grep -o 'pid=[0-9][0-9]*' "$LOG" | sort -u | wc -l | tr -d ' ')
if [[ "$PID_COUNT_AFTER" != "1" ]]; then
    echo "FAIL: the rejected suspension edit restarted the process (unique PIDs: $PID_COUNT_AFTER)"
    cat "$LOG"
    exit 1
fi

tail -200 "$LOG"
HANDLER_BLOCKS=$(grep -c "handler=app phase=UpdateApplication" "$LOG" || true)
if [[ "$HANDLER_BLOCKS" != "3" ]]; then
    echo "FAIL: the rejected suspension edit ran metadata update handlers (blocks: $HANDLER_BLOCKS)"
    cat "$LOG"
    exit 1
fi

echo "PASS: dotnet watch launched one modifiable process while G# applied local, transitive-project, and generated gsgen deltas without restart, ran the metadata update handlers after each one, and rejected a suspension-flipping edit as GSHR1002."
