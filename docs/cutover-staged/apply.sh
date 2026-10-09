#!/usr/bin/env bash
# Apply the staged cut-over content to a checkout. Run once: the text edits assert
# their input, so a second run fails (by design) instead of double-applying.
#
#   docs/cutover-staged/apply.sh [--root DIR] [--check] [--allow-markers] [--force-layout]
#
# --root          checkout to modify (default: the repository containing this script)
# --check         run the edit script in check mode only; copy nothing
# --allow-markers proceed although staged files still contain CUTOVER-VERIFY markers
# --force-layout  skip the "main is G#" guard (used by the dry run on a copy)
#
# Run it in the cut-over PR AFTER the translation and the hand-fix list, on a
# tree whose compiler source is G#. It refuses otherwise, because several edits
# (.csproj -> .gsproj, GSharp.sln -> GSharp.slnx) would break a C# main.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)
check=0 markers=0 force=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) root=$(cd "$2" && pwd); shift 2 ;;
    --check) check=1; shift ;;
    --allow-markers) markers=1; shift ;;
    --force-layout) force=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ $force -eq 0 ]]; then
  if [[ ! -f "$root/src/Core/Core.gsproj" || -f "$root/src/Core/Core.csproj" ]]; then
    echo "Refusing: $root is not a G# tree (expected src/Core/Core.gsproj and no Core.csproj)." >&2
    exit 1
  fi
fi

if [[ $markers -eq 0 ]] && grep -rIl 'CUTOVER-VERIFY' "$here/tree" >/dev/null; then
  echo "Staged files still contain unresolved CUTOVER-VERIFY markers:" >&2
  grep -rIn 'CUTOVER-VERIFY' "$here/tree" >&2
  echo "Resolve them (they are owner decisions), or pass --allow-markers." >&2
  exit 1
fi

python3 "$here/cutover_edits.py" --root "$root" --check

if [[ $check -eq 1 ]]; then
  echo "check passed; nothing written"
  exit 0
fi

# 1. Whole-file replacements and new files.
(cd "$here/tree" && find . -type f -print0) | while IFS= read -r -d '' f; do
  mkdir -p "$root/$(dirname "$f")"
  cp "$here/tree/$f" "$root/$f"
  echo "wrote $f"
done

# 2. Mechanical edits (workflows, CI-matrix scripts, stale docs).
python3 "$here/cutover_edits.py" --root "$root"

# 3. Retired files. Only the PR guard and the self-migration nightly workflow;
#    run-cs2gs-selfmig-{migrate,validate,gate}.sh stay because the cs2gs apps nightly
#    reuses them (they need a source-root parameter, see the README).
for f in \
  .github/workflows/cs2gs-selfmig-nightly.yml \
  build/run-cs2gs-selfmig-pr-guard.sh \
  build/test-cs2gs-selfmig-pr-guard.sh \
  build/cs2gs-pr-guard-control.sh; do
  if [[ -e "$root/$f" ]]; then
    rm -f "$root/$f"
    echo "removed $f"
  fi
done

# 4. Report documentation paths that no longer exist (the 1:1 .cs -> .gs
#    mapping has exceptions: split files).
echo
echo "Documentation references to missing files (fix by hand):"
missing=0
for doc in docs/emit-pipeline.md docs/debug-info.md docs/lsp.md docs/sdk-usage.md \
           website/docs/tooling/compiler-architecture.md; do
  while IFS= read -r p; do
    if [[ ! -e "$root/$p" ]]; then echo "  $doc: $p"; missing=1; fi
  done < <(grep -oE '`(src|test|tools|build|e2etests)/[A-Za-z0-9_./-]+\.[a-z]+`' "$root/$doc" | tr -d '`' | sort -u)
done
[[ $missing -eq 0 ]] && echo "  none"

cat <<'EOF'

Manual steps that remain (see docs/cutover-staged/README.md):
  1. Rebase the build.yml changes onto the current build.yml if apply failed or
     PR #4842 / ADR-0198 changed it (this script edits by exact text; it aborts
     before writing when the text moved).
  2. Rebalance the CI shards in build/generate-ci-test-matrix.py with real G#
     timings; run build/verify-ci-test-partition.py.
  3. GSA0001-GSA0003 are retired (docs/internal-analyzers.md states the gap);
     decide whether to delete src/Analyzers/InternalAnalyzers and its tests.
  4. Add SELFMIG_SOURCE_ROOT to build/selfmig-common.sh, plus
     tools/cs2gs/external/gsharp-csharp.json, tools/cs2gs/apps-nightly-banked.json
     and the cs2gs-nightly label, for cs2gs-apps-nightly.
  5. Wire STAGE2_ARGS in .github/workflows/selfhost-stage2-nightly.yml.
  6. Merge website/docs/release-notes.md text from
     docs/release/release-notes-0.5-draft.md.
  7. Run docs/cutover-staged/TRIAGE-CHECKLIST.md (owner).
  8. After #4842 merges: delete the stage-1 pack/compare steps from test-partition.
  9. Delete docs/cutover-staged/ once applied.
EOF
