#!/usr/bin/env bash
set -euo pipefail

# Every assertion below goes through this helper rather than being a bare
# `[[ ... ]]`, and that is not a style choice. bash 3.2 -- still the system
# bash on macOS, and therefore what a contributor validating locally runs --
# does NOT honour `set -e` for a failing `[[ ]]`, so a bare assertion here is a
# silent no-op locally while failing the job on CI's bash 5. Checking issue
# #4082's fix meant reverting the counter and watching this file report
# "tests passed" anyway; an assertion that cannot fail is worth nothing.
assert_eq() {
  local actual=$1 expected=$2 what=$3
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $what: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scratch="$repo_root/out/test-cs2gs-counters"
tree="$scratch/tree"
rm -rf "$scratch"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$tree"

python3 - "$tree/sample.gs" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
path.write_text(
    "let reducible = " + " + ".join(["x"] * 90) + "\n"
    + "let atomicIdentifier = " + ("a" * 301) + "\n"
    + 'let filteredFixture = "' + ("z" * 301) + '"\n'
    + 'let multiline = (`short` + "\\u0060" + `\n'
    + ("x " * 160) + "\n"
    + "`)\n",
    encoding="utf-8",
)
PY

# shellcheck source=build/selfmig-common.sh
source "$repo_root/build/selfmig-common.sh"

filtered=$(cs2gs_code_lines "$tree")
if [[ "$filtered" == *filteredFixture* ]]; then
  echo "FAIL: a quoted string fixture line survived the code-line filter" >&2
  exit 1
fi

read -r reducible atomic total < <(cs2gs_long_line_counts "$tree")
assert_eq "$reducible $atomic $total" "1 3 4" "long-line counts"

report=$(TMPDIR="$scratch" cs2gs_counter_report "$tree" "counter contract")
grep -Fq '| lines >300 chars (reducible) | n/a | 1 |' <<< "$report"
grep -Fq '| lines >300 chars (single-atom-bounded) | n/a | 3 |' <<< "$report"
grep -Fq '| lines >300 chars (total) | n/a | 4 |' <<< "$report"

selfmig_measure "$tree"
assert_eq "$long_lines $long_lines_atomic" "1 3" "selfmig_measure long lines"

# Issue #4082: a backtick that is NOT a raw-string delimiter must not be
# mistaken for one. The old counter toggled an in-raw flag on per-line backtick
# parity, so a backtick inside a "..." literal, inside a // comment, or as a
# '`' character literal turned the flag on with nothing in the file to turn it
# back off -- and while it is on the widest atom is taken to be the whole line,
# so every later long line in that file is filed as single-atom-bounded
# ("no formatter can reach this") instead of reducible ("wrap it"). One file
# per trigger, because the flag resets per file: a single file mixing them
# would let two odd-parity lines cancel and hide the defect. The fourth file is
# a REAL raw string and must still count as single-atom-bounded, so this test
# fails on an over-correction as well as on the original bug.
tree4082="$scratch/tree-4082"
mkdir -p "$tree4082"
python3 - "$tree4082" <<'PY'
import pathlib
import sys

tree = pathlib.Path(sys.argv[1])
wrappable = "let reducible = " + " + ".join(["x"] * 90) + "\n"

# A backtick inside an ordinary string literal is text, not a delimiter.
# src/Core/CodeAnalysis/DiagnosticDescriptors.gs really says this.
(tree / "dq.gs").write_text(
    'let message = "Unsupported Markdown: use ```xmldoc for complex constructs."\n'
    + wrappable,
    encoding="utf-8",
)

# A backtick inside a comment is prose. src/Core/.../Binder.gs really says this.
(tree / "comment.gs").write_text(
    "// CLR imports use the mangled name `Name`N`, so `List[int]` resolves.\n"
    + wrappable,
    encoding="utf-8",
)

# A backtick can be the value of a character literal.
(tree / "charlit.gs").write_text(
    "let tick = '`'\n" + wrappable,
    encoding="utf-8",
)

# ...and a real raw string still opens one: its body line is unreachable.
(tree / "raw.gs").write_text(
    "let real = (`\n" + ("x " * 160) + "\n`)\n",
    encoding="utf-8",
)
PY

read -r reducible atomic total < <(cs2gs_long_line_counts "$tree4082")
assert_eq "$reducible $atomic $total" "3 1 4" "issue #4082 non-delimiter backticks"

cat > "$scratch/baseline.json" <<'JSON'
{
  "greenFloor": 0,
  "syntheticLabelCeiling": 0,
  "liftedLocalCeiling": 0,
  "longLineCeiling": 0,
  "nullAssertionCeiling": 0,
  "greenApps": []
}
JSON

if output=$(TMPDIR="$scratch" selfmig_apply_baseline "$scratch/baseline.json" 0 0 2>&1); then
  echo "expected the raw reducible long-line ceiling to fail" >&2
  exit 1
fi
grep -Fq 'lines>300(raw)=1 reducible' <<< "$output"
grep -Fq 'GATE: reducible raw >300-char line count 1 exceeded ceiling 0.' <<< "$output"

python3 "$repo_root/build/test-check-selfmig-stage-floor.py"

cat > "$scratch/stage-baseline.json" <<'JSON'
{
  "greenFloor": 0,
  "syntheticLabelCeiling": 1,
  "liftedLocalCeiling": 1,
  "longLineCeiling": 1,
  "nullAssertionCeiling": 1,
  "greenApps": [],
  "stageFloor": {
    "test/Red.Tests/Red.Tests.csproj": "test-parity"
  }
}
JSON
cat > "$scratch/stage-run.json" <<'JSON'
{
  "apps": [
    {
      "appId": "test/Red.Tests/Red.Tests.csproj",
      "succeeded": false,
      "unverified": false,
      "stages": [
        {"stage": "translate", "status": "passed"},
        {"stage": "compile", "status": "failed"},
        {"stage": "ilverify", "status": "skipped"},
        {"stage": "test-parity", "status": "skipped"}
      ]
    }
  ]
}
JSON
if output=$(TMPDIR="$scratch" selfmig_apply_baseline \
  "$scratch/stage-baseline.json" 0 1 "$scratch/stage-run.json" 2>&1); then
  echo "expected a stage-floor regression to fail the integrated gate" >&2
  exit 1
fi
grep -Fq "regressed below stage floor 'test-parity': reached 'compile'" <<< "$output"

measurement_tree="$scratch/measurement-tree"
artifact="$measurement_tree/out/bin/Release/Cs2Gs.Tests/issue-2231-e2e/guid/Snippet.gs"
source_file="$measurement_tree/out/scratch/Translated.gs"
mkdir -p "$(dirname "$artifact")" "$(dirname "$source_file")"
python3 - "$artifact" <<'PY'
import pathlib
import sys

pathlib.Path(sys.argv[1]).write_text(
    "goto __patternGuardEnd0\n"
    "__patternGuardEnd0:\n"
    "let __local_0 = value!!\n"
    + "let reducible = " + " + ".join(["x"] * 90) + "\n",
    encoding="utf-8",
)
PY
for generated in \
  "$measurement_tree/out/BiN/Release/App/Snippet.gs" \
  "$measurement_tree/out/OBJ/Release/App/Snippet.gs" \
  "$measurement_tree/out/TeStReSuLtS/App/Snippet.gs"
do
  mkdir -p "$(dirname "$generated")"
  cp "$artifact" "$generated"
done

selfmig_measure "$measurement_tree"
assert_eq "$labels $lifts $long_lines $long_lines_atomic $bangs" "0 0 0 0 0" "generated-tree exclusion"

report=$(TMPDIR="$scratch" cs2gs_counter_report "$measurement_tree" "artifact exclusion")
grep -Fq '| `.gs` files | 0 | 0 |' <<< "$report"
grep -Fq '| `!!` null assertions | 0 | 0 |' <<< "$report"
grep -Fq '| lines >300 chars (reducible) | n/a | 0 |' <<< "$report"
grep -Fq '| lines >300 chars (single-atom-bounded) | n/a | 0 |' <<< "$report"
grep -Fq '| lines >300 chars (total) | n/a | 0 |' <<< "$report"
grep -Fq '| synthetic `__` identifiers | 0 | 0 |' <<< "$report"

cp "$artifact" "$source_file"
selfmig_measure "$measurement_tree"
assert_eq "$labels $lifts $long_lines $long_lines_atomic $bangs" "2 1 1 0 1" "translated-source counters"

report=$(TMPDIR="$scratch" cs2gs_counter_report "$measurement_tree" "artifact exclusion")
grep -Fq '| `.gs` files | 1 | 1 |' <<< "$report"
grep -Fq '| `__patternGuardEnd` | 2 | 2 |' <<< "$report"
grep -Fq '| `__local_` | 1 | 1 |' <<< "$report"
grep -Fq '| `!!` null assertions | 1 | 1 |' <<< "$report"
grep -Fq '| lines >300 chars (reducible) | n/a | 1 |' <<< "$report"
grep -Fq '| lines >300 chars (single-atom-bounded) | n/a | 0 |' <<< "$report"
grep -Fq '| lines >300 chars (total) | n/a | 1 |' <<< "$report"
grep -Fq '| synthetic `__` identifiers | 3 | 3 |' <<< "$report"

echo "cs2gs counter contract tests passed"
