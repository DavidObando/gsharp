#!/usr/bin/env bash
set -euo pipefail

# relevant-paths: reads NUL-separated changed paths on stdin; exits 0 (and
# prints the first match) when any path can affect the PR-time self-migration
# gate (build.yml job `selfmig-scope`), 1 when none can.

case "${1:-}" in
  relevant-paths)
    while IFS= read -r -d '' path; do
      case "$path" in
        .config/*|.editorconfig|.gitattributes|build/*|\
        src/Analyzers/*|src/Compiler/*|src/Core/*|\
        src/Formatting/*|src/Sdk/*|tools/*|Directory.Build.*|\
        Directory.Packages.props|global.json|GSharp.sln|nuget.config|version.json|\
        test/Shared/*|.github/workflows/build.yml|\
        .github/workflows/cs2gs-selfmig.yml)
          printf '%s\n' "$path"
          exit 0
          ;;
      esac
    done
    exit 1
    ;;

  *)
    echo "usage: $0 {relevant-paths}" >&2
    exit 2
    ;;
esac
