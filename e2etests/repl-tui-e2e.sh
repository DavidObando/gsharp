#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

dotnet build src/Repl/Repl.csproj -c Release --no-restore --nologo -v:q
python3 e2etests/repl-tui-e2e.py
