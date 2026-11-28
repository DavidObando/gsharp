#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

dotnet restore src/Repl/Repl.gsproj --locked-mode --nologo -v:q
dotnet build src/Repl/Repl.gsproj -c Release --no-restore -graph --nologo -v:q
python3 e2etests/repl-tui-e2e.py
