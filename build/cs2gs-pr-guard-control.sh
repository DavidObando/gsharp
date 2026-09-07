#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  relevant-paths)
    while IFS= read -r -d '' path; do
      case "$path" in
        .config/*|.editorconfig|.gitattributes|build/*|\
        src/Analyzers/*|src/Compiler/*|src/Core/*|\
        src/Formatting/*|src/Sdk/*|tools/*|Directory.Build.*|\
        Directory.Packages.props|global.json|GSharp.sln|nuget.config|version.json|\
        test/Shared/*|.github/workflows/cs2gs-pr-guard.yml)
          printf '%s\n' "$path"
          exit 0
          ;;
      esac
    done
    exit 1
    ;;

  cancellation)
    messages=$(jq -r 'if type == "array" then .[]?.message // empty else error("expected array") end')
    if grep -Eqi 'exceeded the maximum execution time|timed out after' <<< "$messages"; then
      echo timeout
    elif grep -Eqi 'Canceling since a higher priority waiting request' <<< "$messages"; then
      echo superseded
    else
      echo unknown
    fi
    ;;

  *)
    echo "usage: $0 {relevant-paths|cancellation}" >&2
    exit 2
    ;;
esac
