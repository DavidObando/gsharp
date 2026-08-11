#!/usr/bin/env bash
# Issue #3339: validates dotnet-watch project loading plus G# runtime deltas.
# Covers a local body edit, a referenced G# project, and a foreign C# source
# that must pass through gsgen before gsc.
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
        "$SAMPLE/App/GeneratedLike.cs" \
        "$SAMPLE/Lib/Values.gs" 2>/dev/null || true
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
       "$SAMPLE/Lib/bin" "$SAMPLE/Lib/obj"

echo "==> Restoring hot-reload sample"
dotnet restore "$APP" --nologo

echo "==> Starting dotnet watch"
: > "$LOG"
dotnet watch --project "$APP" --no-restore --non-interactive >"$LOG" 2>&1 &
WATCH_PID=$!

wait_for "values=1,2,3" "initial application output"

echo "==> Applying local G# method-body edit"
replace_once "$SAMPLE/App/App.gs" "return 1" "return 11"
wait_for "values=11,2,3" "local G# delta"

echo "==> Applying referenced-project method-body edit"
replace_once "$SAMPLE/Lib/Values.gs" "return 2" "return 22"
wait_for "values=11,22,3" "referenced-project delta"

echo "==> Applying gsgen-translated foreign C# edit"
replace_once "$SAMPLE/App/GeneratedLike.cs" "=> 3;" "=> 33;"
wait_for "values=11,22,33" "gsgen delta"

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

APPLY_COUNT=$(grep -c "G# hot reload: applied" "$LOG" || true)
if [[ "$APPLY_COUNT" -lt 3 ]]; then
    echo "FAIL: expected at least three applied G# deltas, saw $APPLY_COUNT"
    cat "$LOG"
    exit 1
fi

tail -200 "$LOG"
echo "PASS: dotnet watch loaded .gsproj and applied local, project-reference, and gsgen G# deltas without restart."
