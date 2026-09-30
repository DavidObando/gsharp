#!/usr/bin/env bash
set -euo pipefail

# relevant-paths: reads NUL-separated changed paths on stdin; exits 0 (and
# prints the first match) when any path can affect the PR-time self-migration
# gate (build.yml job `selfmig-scope`), 1 when none can.
#
# The gate is the FULL self-migration, whose discovery roots are the whole
# repository (every non-excluded project, including src/*, test/*,
# test-assets/*, tools/*, samples and e2e fixtures). So this classifier is a
# DENYLIST of paths that are provably inert: everything not listed below
# selects the gate. A new top-level directory therefore fails safe (runs the
# gate) instead of silently bypassing it.

case "${1:-}" in
  relevant-paths)
    while IFS= read -r -d '' path; do
      case "$path" in
        # The gate's own definition is an input even though it lives in .github.
        .github/workflows/build.yml|.github/workflows/cs2gs-selfmig.yml)
          printf '%s\n' "$path"
          exit 0
          ;;
        # Inert: documentation, website, design notes, repo assets, issue /
        # PR templates and other workflows, editor extensions without a
        # migrated project, and top-level prose.
        docs/*|website/*|design/*|assets/*|.github/*|src/vscode-gsharp/*|\
        *.md|LICENSE|.gitignore)
          ;;
        *)
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
