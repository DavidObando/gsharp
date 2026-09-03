#!/usr/bin/env bash
# Issue #3339: validates dotnet-watch project loading plus G# runtime deltas.
# Covers a local body edit, a transitive G# project, and an Avalonia-style
# generated C# source that must pass through gsgen before gsc.
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

replace_once() {
    local path="$1"
    local before="$2"
    local after="$3"
    python3 - "$path" "$before" "$after" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
before = sys.argv[2]
after = sys.argv[3]
text = path.read_text()
if before not in text:
    raise SystemExit(f"missing expected text in {path}: {before}")
path.write_text(text.replace(before, after, 1))
PY
}

echo "==> Packing Gsharp.NET.Sdk"
dotnet build src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.csproj -c Release --nologo -v:q
mkdir -p .nugs
cp out/bin/Release/nupkgs/Gsharp.NET.Sdk.*.nupkg .nugs/

NUPKG=$(ls -t out/bin/Release/nupkgs/Gsharp.NET.Sdk.*.nupkg | head -1)
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

echo "==> Applying transitive project-reference method-body edit"
replace_once "$SAMPLE/Base/Values.gs" "return 2" "return 22"
wait_for "values=11,22,3" "transitive project-reference delta"

echo "==> Applying Avalonia-style generated-input edit"
replace_once "$SAMPLE/App/GeneratedValue.axaml" 'Value="3"' 'Value="33"'
wait_for "values=11,22,33" "generated gsgen delta"

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
echo "PASS: dotnet watch launched one modifiable process while G# applied local, transitive-project, and generated gsgen deltas without restart, and rejected a suspension-flipping edit as GSHR1002."
