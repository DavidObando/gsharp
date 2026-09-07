#!/usr/bin/env bash
set -euo pipefail

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
[[ "$filtered" != *filteredFixture* ]]

read -r reducible atomic total < <(cs2gs_long_line_counts "$tree")
[[ "$reducible $atomic $total" == "1 3 4" ]]

report=$(TMPDIR="$scratch" cs2gs_counter_report "$tree" "counter contract")
grep -Fq '| lines >300 chars (reducible) | n/a | 1 |' <<< "$report"
grep -Fq '| lines >300 chars (single-atom-bounded) | n/a | 3 |' <<< "$report"
grep -Fq '| lines >300 chars (total) | n/a | 4 |' <<< "$report"

selfmig_measure "$tree"
[[ "$long_lines $long_lines_atomic" == "1 3" ]]

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

echo "cs2gs counter contract tests passed"
