#!/usr/bin/env bash
# Issue #3501: the readability counters, shared by EVERY cs2gs corpus.
#
# Three jobs translate a whole C# repository to G# and can therefore measure
# the same things: the repo self-migration (build/run-cs2gs-selfmig*.sh), Oahu
# (build/run-cs2gs-oahu.sh) and code-exploder (build/run-cs2gs-code-exploder.sh).
# Until now only the self-migration reported any of it, so a synthetic
# identifier that the gsharp corpus happens not to produce was invisible to CI.
# That is not hypothetical: #3897 found THREE families no counter knew about
# (`__caught`, `__gsAsyncVoid*`/`__asyncVoid_*`, `__foreachN`) only because a
# human translated Oahu and read the output. All three have since been retired
# by language work (#3899 rethrow, #3913 ADR-0177 catch parity, #3921 native
# async void, #3925 typed range clauses) — this file exists so the NEXT one
# shows up in a job summary instead of waiting for someone to notice.
#
# Hence the catch-all family: every `__`-prefixed identifier that matches none
# of the known families is counted, and its distinct spellings are named. The
# definition of done for #3501 is ZERO `__`-prefixed synthetic identifiers, so
# this table is the progress measure for that goal.
#
# COUNTS EVERYWHERE, RATCHET ONLY WHERE ONE ALREADY EXISTS. This file measures;
# it never gates. The self-migration keeps its ceilings from
# tools/cs2gs/selfmig-baseline.json (applied in build/selfmig-common.sh); Oahu
# and code-exploder report the same counters with no thresholds, because a
# ceiling nobody has baselined is red on day one.
#
# Sourced, never executed.

# The known synthetic-identifier families, as IDENTIFIER PREFIXES. Longest
# match wins, so `__gotoCase` is not swallowed by a shorter sibling. Anything
# starting `__` that matches none of these lands in the catch-all row.
#
# Format: "<prefix>|<note>". The note is documentation printed in the table —
# where the family comes from, or what retired it.
# The LIVE families are the string literals the translator actually emits —
#   grep -rhoE '"__[A-Za-z0-9_]+' tools/cs2gs/Cs2Gs.{Translator,Pipeline,CodeModel} src/Core
# — so this list is derived, not remembered. The RETIRED ones are kept as rows
# so that a family coming back reads as a regression rather than as a new
# discovery; they must stay 0.
cs2gs_synthetic_families=(
  # live
  '__cs2gs_|translator-reserved prefix'
  '__anon|anonymous-type temporary'
  '__arg|argument spill (evaluation order)'
  '__decon|deconstruction temporary'
  '__generatedRegex_|[GeneratedRegex] backing member'
  '__local_|lifted local helper (GATED: liftedLocalCeiling)'
  '__pattern|pattern-matching temporary'
  '__q|query/LINQ range temporary'
  '__scrutinee|switch scrutinee temporary'
  '__spill|expression spill temporary'
  '__underscore|discard rename'
  # retired: these must stay 0
  '__switchExit|switch lowering label (GATED: syntheticLabelCeiling)'
  '__iteratorExit|iterator lowering label (GATED: syntheticLabelCeiling)'
  '__gotoCase|goto-case label (GATED: syntheticLabelCeiling)'
  '__gotoDefault|goto-default label (GATED: syntheticLabelCeiling)'
  '__patternGuardEnd|pattern-guard label (GATED: syntheticLabelCeiling)'
  '__caught|retired by #3899 (rethrow)'
  '__gsAsyncVoid|retired by #3921 (native async void)'
  '__asyncVoid_|retired by #3921 (native async void)'
  '__foreach|retired by #3925 (typed range clauses)'
  '__cast|retired (explicit-cast temporary)'
  '__coalesce|retired (?? lowering temporary)'
  '__init|retired (object-initializer temporary)'
  '__spread|retired (collection-spread temporary)'
  '__using|retired (using-statement temporary)'
)

# How many distinct unknown identifiers to name in the table before truncating.
cs2gs_unknown_sample_limit=${CS2GS_UNKNOWN_SAMPLE_LIMIT:-25}

# Visits translated source files while pruning generated project-output trees.
# Validation can create transient .gs test fixtures under these directories;
# they are artifacts, not translator output, and must not move readability
# counters. Callers supply the find action so every metric shares this scope.
cs2gs_find_translated_sources() {
  local tree=$1
  shift
  find "$tree" \
    \( -type d \( \
      -iname bin -o \
      -iname obj -o \
      -iname TestResults \
    \) -prune \) -o \
    \( -type f -name '*.gs' "$@" \)
}

# Emits the CODE lines of a migrated tree: every line of every .gs file minus
# the ones that are not code for metric purposes.
#
# The exclusions are inherited verbatim from selfmig_code_grep, deliberately:
# migrated test sources embed expected-output strings and docs quote G#
# constructs, so a line containing a string quote, or a line that is a comment,
# is dropped before counting. That filter UNDERCOUNTS — #3937's one removed `!!`
# was invisible because its line read `Arguments: []object{uri!!, ...}` — but
# the self-migration ceilings in tools/cs2gs/selfmig-baseline.json were all
# measured through it, so changing it would silently move every ceiling. The
# filter therefore stays exactly as it was and the RAW count is reported
# alongside, clearly labelled, so the gap is visible instead of merely absent.
cs2gs_code_lines() {
  local tree=$1
  cs2gs_find_translated_sources "$tree" -exec cat {} + 2>/dev/null \
    | grep -v '"' | grep -vE '^[[:space:]]*//' || true
}

# Every line of every .gs file, unfiltered.
cs2gs_raw_lines() {
  local tree=$1
  cs2gs_find_translated_sources "$tree" -exec cat {} + 2>/dev/null || true
}

# Prints "<reducible> <single-atom-bounded> <total>" for lines wider than 300
# characters. A line is single-atom-bounded when its indentation plus the
# widest string/identifier atom already exceeds the budget; no formatter
# can shorten that line without changing the token stream (ADR-0179).
#
# Deciding which lines sit inside a backtick raw string used to be
# `raw_line.count("`") % 2` -- toggle a flag on odd backtick parity, per line.
# Issue #4082: that counts backticks that are not raw-string delimiters at all.
# A backtick inside a "..." literal is text (DiagnosticDescriptors.gs says
# "Use ```xmldoc for complex XML-doc constructs."), a backtick inside a `//`
# comment is prose (Binder.gs writes "mangled name `Name`N`"), and '`' is a
# character literal (GSharpPrinter.gs tests for one). Each of those flipped the
# flag with NOTHING to flip it back, and while the flag is wrongly set the
# widest atom is taken to be the whole line -- so every later long line in the
# file is filed as single-atom-bounded, the bucket meaning "no formatter can
# reach this". On the run-34232380469 tree that misfiled 121 of 590 long lines,
# every one of them in the direction that hides work from the GATED reducible
# count.
#
# The fix is a file-level scan rather than a wider per-line mask, deliberately.
# Masking only "..." literals recovers 70 of those 121 and still leaves 51
# misfiled by the comment and character-literal cases, and it
# leaves the real fragility in place: a heuristic whose failure mode is
# UNBOUNDED, because one bad line silently corrupts every line after it.
# raw_string_flags below tracks the lexical state each line STARTS in, so a
# backtick only opens a raw string where a raw string can actually open. The
# blast radius is bounded as well: a "..." or '...' literal cannot span a
# newline, so any state this scanner does get wrong is reset at the next line
# instead of running to end of file. (Raw strings, block comments and ADR-0055
# multiline interpolation holes genuinely do span newlines and are carried
# across, matching the real lexer.)
#
# Fidelity to Lexer.cs is the whole point, so the two places this scanner
# initially diverged from it are fixed even though neither moves a count on
# today's tree: `$$` escaping to a literal `$` (Lexer.cs:905-915) and multiline
# `${...}` holes (Lexer.cs:824-830). A scanner that mishandles a construct the
# real lexer accepts is the same class of latent, input-dependent corruption
# #4082 was, and the count being right today is luck rather than design.
cs2gs_long_line_counts() {
  local tree=$1
  python3 - 3< <(cs2gs_find_translated_sources "$tree" -print0) <<'PY'
import os
import pathlib
import re


def raw_string_flags(lines):
    """For each line, whether it STARTS inside a backtick raw string.

    A small lexer over G# surface syntax: backtick raw strings (which have no
    escape, so the next backtick always closes one), "..." literals (backslash
    escapes, `$$` escaping to a literal `$`, plus ${...} interpolation holes
    whose contents are code and may contain nested string literals), '...'
    character literals, // line comments and /* */ block comments. Only raw
    strings, block comments and interpolation holes carry across a newline;
    every other state is reset there, so a misread cannot cascade past the line
    that caused it.
    """
    flags = []
    state = "code"
    holes = []
    depth = 0
    for line in lines:
        flags.append(state == "raw")
        index, length = 0, len(line)
        while index < length:
            char = line[index]
            nxt = line[index + 1] if index + 1 < length else ""
            if state == "code":
                if char == "`":
                    state = "raw"
                elif char == '"':
                    state = "dq"
                elif char == "'":
                    state = "char"
                elif char == "/" and nxt == "/":
                    break
                elif char == "/" and nxt == "*":
                    state = "block"
                    index += 1
                elif holes:
                    if char == "{":
                        depth += 1
                    elif char == "}":
                        if depth == 0:
                            state = "dq"
                            depth = holes.pop()
                        else:
                            depth -= 1
            elif state == "raw":
                if char == "`":
                    state = "code"
            elif state == "dq":
                if char == "\\":
                    index += 1
                elif char == "$" and nxt == "$":
                    # `$$` is the escape for a literal `$` (Lexer.cs:905-915),
                    # so the second `$` cannot open a hole: in "$${" the brace
                    # is an ordinary character and the literal runs on. Reading
                    # it as an opener instead swallows the literal's own closing
                    # quote as the START of a new one, and a raw-string opener
                    # later on that line is then lost inside it.
                    index += 1
                elif char == "$" and nxt == "{":
                    holes.append(depth)
                    depth = 0
                    state = "code"
                    index += 1
                elif char == '"':
                    state = "code"
            elif state == "char":
                if char == "\\":
                    index += 1
                elif char == "'":
                    state = "code"
            elif state == "block":
                if char == "*" and nxt == "/":
                    state = "code"
                    index += 1
            index += 1
        if state not in ("raw", "block"):
            # A "..." or '...' literal cannot span a newline -- Lexer.cs:824-830
            # reports a diagnostic for one that tries -- so the line boundary
            # ends it and a misread costs one line, not the rest of the file.
            state = "code"

        # `holes`/`depth` deliberately SURVIVE the boundary. ADR-0055 holes are
        # scanned by a sub-scanner that permits newlines (Lexer.cs:824-830,
        # samples/InterpolatedStringRichHoles.gs:17-19), so a `${` opened on one
        # line may close on a later one. Clearing the stack here left the
        # continuation's `}` unable to restore `dq`, and the rest of that line
        # -- including any raw-string opener on it -- was then read in the wrong
        # state. Carrying the stack does not reintroduce an unbounded failure
        # mode: a stale entry can only turn a later top-level `}` into `dq`, and
        # `dq` is itself reset at the next boundary by the branch above.
    return flags


string_atom = re.compile(r'"(?:\\.|[^"\\])*"')
identifier_atom = re.compile(r'\b[A-Za-z_$][A-Za-z0-9_$]*\b')
reducible = atomic = 0

for raw_path in os.fdopen(3, "rb").read().split(b"\0"):
    if not raw_path:
        continue
    path = pathlib.Path(os.fsdecode(raw_path))
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    in_raw_flags = raw_string_flags(lines)
    for line_index, raw_line in enumerate(lines):
        if len(raw_line) <= 300:
            continue

        indent = len(raw_line) - len(raw_line.lstrip())
        widest = 0
        if in_raw_flags[line_index]:
            widest = len(raw_line.lstrip())
        else:
            widest = max(
                [len(match.group(0)) for match in string_atom.finditer(raw_line)]
                + [len(match.group(0)) for match in identifier_atom.finditer(raw_line)]
                + [0]
            )

        if indent + 8 + widest > 300:
            atomic += 1
        else:
            reducible += 1

print(reducible, atomic, reducible + atomic)
PY
}

# Counts occurrences of an extended regex in a stream on stdin.
#
# A ZERO-match metric is success, not failure: without the `|| true`, the
# no-match grep's exit 1 kills the caller under `set -eo pipefail` before the
# ceilings are ever checked (exactly what happened once the synthetic label
# count reached 0).
cs2gs_count_stream() {
  local pattern=$1 count
  count=$(grep -oE "$pattern" | wc -l | tr -d ' ') || true
  echo "${count:-0}"
}

# Reads `__`-prefixed identifiers on stdin, one per line, and writes
# "<family>\t<identifier>" — family being the longest matching known prefix, or
# the literal `(unknown)`.
cs2gs_classify_synthetics() {
  local prefixes
  prefixes=$(printf '%s\n' "${cs2gs_synthetic_families[@]}" | cut -d'|' -f1 | tr '\n' ' ')
  awk -v prefixes="$prefixes" '
    BEGIN { n = split(prefixes, p, " ") }
    {
      fam = "(unknown)"; best = 0
      for (i = 1; i <= n; i++) {
        if (index($0, p[i]) == 1 && length(p[i]) > best) { fam = p[i]; best = length(p[i]) }
      }
      print fam "\t" $0
    }'
}

# Extracts every `__`-prefixed identifier occurrence from a stream on stdin.
cs2gs_extract_synthetics() {
  grep -oE '__[A-Za-z0-9_]+' || true
}

# Reads "<family> <count>" tally lines and prints the count for one family, or
# 0 when the family did not occur. A family with zero occurrences must print 0,
# not vanish and not abort the run.
cs2gs_tally_lookup() {
  local tally=$1 family=$2
  awk -v f="$family" '$1 == f { print $2; found = 1 } END { if (!found) print 0 }' "$tally"
}

# Writes the markdown job-summary section for a migrated tree to stdout.
#
#   cs2gs_counter_report <migrated-tree> <heading> [subtitle]
#
# Two tables under one heading: the corpus-wide counters, then the synthetic
# `__identifier` breakdown per family with the catch-all row last. Both carry a
# "code" column (quote/comment-filtered) and a "raw" column (unfiltered).
# Long-line counts are raw-only because longLineCeiling deliberately gates the
# formatter-reducible raw count; `n/a` keeps that denominator explicit.
#
# Callers append the output to $GITHUB_STEP_SUMMARY, print it, or both. It is
# pure text — this function neither gates nor exits.
cs2gs_counter_report() {
  local tree=$1 heading=$2 subtitle=${3:-}
  local tmp code_lines raw_lines code_ids raw_ids code_tally raw_tally
  tmp=$(mktemp -d)
  code_lines="$tmp/code" raw_lines="$tmp/raw"
  code_ids="$tmp/code-ids" raw_ids="$tmp/raw-ids"
  code_tally="$tmp/code-tally" raw_tally="$tmp/raw-tally"

  cs2gs_code_lines "$tree" > "$code_lines"
  cs2gs_raw_lines "$tree" > "$raw_lines"
  cs2gs_extract_synthetics < "$code_lines" | cs2gs_classify_synthetics > "$code_ids"
  cs2gs_extract_synthetics < "$raw_lines" | cs2gs_classify_synthetics > "$raw_ids"
  # "<family> <count>" per line. One pass each; bash 3.2 (macOS) has no
  # associative arrays, so the tally lives in a file and is looked up per row.
  awk -F'\t' '{ c[$1]++ } END { for (f in c) print f, c[f] }' "$code_ids" > "$code_tally"
  awk -F'\t' '{ c[$1]++ } END { for (f in c) print f, c[f] }' "$raw_ids" > "$raw_tally"

  local gs_files bangs bangs_raw long_lines atomic_long_lines total_long_lines syn_total syn_total_raw
  gs_files=$(cs2gs_find_translated_sources "$tree" -print | wc -l | tr -d ' ')
  bangs=$(cs2gs_count_stream '!!' < "$code_lines")
  bangs_raw=$(cs2gs_count_stream '!!' < "$raw_lines")
  read -r long_lines atomic_long_lines total_long_lines < <(cs2gs_long_line_counts "$tree")
  syn_total=$(wc -l < "$code_ids" | tr -d ' ')
  syn_total_raw=$(wc -l < "$raw_ids" | tr -d ' ')

  echo "### $heading"
  echo ''
  if [[ -n "$subtitle" ]]; then
    echo "$subtitle"
    echo ''
  fi
  echo "| counter | code | raw |"
  echo "|---|---:|---:|"
  echo "| \`.gs\` files | $gs_files | $gs_files |"
  echo "| \`!!\` null assertions | $bangs | $bangs_raw |"
  echo "| lines >300 chars (reducible) | n/a | $long_lines |"
  echo "| lines >300 chars (single-atom-bounded) | n/a | $atomic_long_lines |"
  echo "| lines >300 chars (total) | n/a | $total_long_lines |"
  echo "| synthetic \`__\` identifiers | $syn_total | $syn_total_raw |"
  echo ''
  echo "Synthetic \`__identifier\`s by family (#3501 target: all zero)"
  echo ''
  echo "| family | code | raw | note |"
  echo "|---|---:|---:|---|"

  local entry prefix note n n_raw
  for entry in "${cs2gs_synthetic_families[@]}"; do
    prefix=${entry%%|*}
    note=${entry#*|}
    n=$(cs2gs_tally_lookup "$code_tally" "$prefix")
    n_raw=$(cs2gs_tally_lookup "$raw_tally" "$prefix")
    echo "| \`$prefix\` | $n | $n_raw | $note |"
  done

  local unknown unknown_raw
  unknown=$(cs2gs_tally_lookup "$code_tally" '(unknown)')
  unknown_raw=$(cs2gs_tally_lookup "$raw_tally" '(unknown)')
  echo "| **other \`__\` (unknown family)** | ${unknown:-0} | ${unknown_raw:-0} | see below |"
  echo ''

  if (( unknown_raw > 0 )); then
    local names total_distinct
    names=$(awk -F'\t' '$1 == "(unknown)" { print $2 }' "$raw_ids" | sort | uniq -c | sort -rn)
    total_distinct=$(printf '%s\n' "$names" | wc -l | tr -d ' ')
    echo "UNKNOWN synthetic identifier families ($total_distinct distinct). These match no family this"
    echo "counter knows about — either a new lowering shipped, or a family was renamed. Add it to"
    echo "\`cs2gs_synthetic_families\` in \`build/cs2gs-counters.sh\` (or retire it in the compiler)."
    echo ''
    echo '```'
    printf '%s\n' "$names" | head -n "$cs2gs_unknown_sample_limit"
    if (( total_distinct > cs2gs_unknown_sample_limit )); then
      echo "... $(( total_distinct - cs2gs_unknown_sample_limit )) more"
    fi
    echo '```'
    echo ''
  fi

  rm -rf "$tmp"
}

# Convenience wrapper: print the report to the log AND to the job summary.
cs2gs_emit_counter_report() {
  local tree=$1 heading=$2 subtitle=${3:-} report
  if [[ ! -d "$tree" ]]; then
    echo "cs2gs counters: no migrated tree at '$tree'; skipping the summary." >&2
    return 0
  fi
  report=$(cs2gs_counter_report "$tree" "$heading" "$subtitle")
  printf '%s\n' "$report"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$report" >> "$GITHUB_STEP_SUMMARY"
  fi
}
