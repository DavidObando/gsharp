#!/usr/bin/env python3
"""Rewrite Compilation.Evaluate test-oracle call sites to EmittedOracle.

ADR-0156 Phase 3b (issue #3176): mechanical migration of the canonical
Compilation.Evaluate oracle shapes onto the shared emitted oracle in
test/Shared/EmittedOracle.cs. Phase 3b.0 pilots it on Interpreter.Tests;
Phase 3b.1 reuses it for the ~195 canonical per-file helpers in Core.Tests.

Handled shapes (everything else is left untouched and reported as residue):

  T1  inline chain, single- or multi-line:
        new Compilation(SyntaxTree.Parse(<id>))
            .Evaluate(new Dictionary<VariableSymbol, object>())
      (also with SourceText.From(<id>) inside Parse)
        -> EmittedOracle.Evaluate(<id>)

  T2  canonical block helper body:
        var tree = SyntaxTree.Parse(<id>);            # or SourceText.From(<id>)
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        -> return EmittedOracle.Evaluate(<id>);

  T3  helper return-type retype: a `private static EvaluationResult
      <Name>(string source)` helper whose (rewritten) body is now a direct
      EmittedOracle.Evaluate call -> EmittedOracleResult.

  T4  add `using GSharp.Tests;` (sorted) when the rewrite introduced
      EmittedOracle into a file outside that namespace.

  T5  canonical console-capture helper body (parse/compile, StringWriter +
      Console.SetOut/restore around Evaluate(variables), error-guard lines,
      return of the normalized captured text):
        -> `var result = EmittedOracle.Evaluate(<id>);` + the error-guard
           lines (dedented out of the deleted try) + `return
           result.Output.Replace(...)` on the oracle's captured stream.

Usage:
  build/migrate-emitted-oracle.py [--dry-run] FILE [FILE ...]

Exits 0; prints a per-file transform summary plus a residue report of files
that still reference Compilation-based .Evaluate( call shapes and need a
hand-fix (console-capture helpers, dual-oracle comparisons, ...).
"""

from __future__ import annotations

import argparse
import re
import sys

IDENT = r"[A-Za-z_][A-Za-z0-9_]*"

# SyntaxTree.Parse(x) / SyntaxTree.Parse(SourceText.From(x)) where x is an
# identifier or a simple string-concatenation expression without parens.
PARSE_ARG = rf"(?:SourceText\.From\((?P<arg1>[^()]+)\)|(?P<arg2>{IDENT}))"

T1_INLINE = re.compile(
    rf"new Compilation\(SyntaxTree\.Parse\({PARSE_ARG}\)\)\s*\n?\s*"
    r"\.Evaluate\(new Dictionary<VariableSymbol, object>\(\)\)",
)

T2_BLOCK = re.compile(
    rf"var tree = SyntaxTree\.Parse\({PARSE_ARG}\);\s*\n"
    r"(?P<indent>[ \t]*)var compilation = new Compilation\(tree\);\s*\n"
    r"[ \t]*return compilation\.Evaluate\(new Dictionary<VariableSymbol, object>\(\)\);",
)

T3_RETYPE = re.compile(
    r"private static EvaluationResult (?P<name>\w+)\(string (?P<param>\w+)\)"
    r"(?P<body>\s*(?:=>\s*EmittedOracle\.Evaluate|\{[^{}]*?EmittedOracle\.Evaluate))",
)

T5_CONSOLE_HELPER = re.compile(
    rf"(?P<ind>[ \t]*)var tree = SyntaxTree\.Parse\((?P<src>{IDENT})\);\n"
    r"[ \t]*var compilation = new Compilation\(tree\);\n\n"
    r"[ \t]*using var (?P<w>\w+) = new StringWriter\(\);\n"
    r"[ \t]*var (?P<p>\w+) = Console\.Out;\n"
    r"[ \t]*Console\.SetOut\((?P=w)\);\n"
    r"[ \t]*try\n[ \t]*\{\n"
    r"[ \t]*var variables = new Dictionary<VariableSymbol, object>\(\);\n"
    r"[ \t]*var result = compilation\.Evaluate\(variables\);\n"
    r"(?P<mid>(?:[^\n]*\n)*?)"
    r"[ \t]*\}\n"
    r"[ \t]*finally\n[ \t]*\{\n"
    r"[ \t]*Console\.SetOut\((?P=p)\);\n"
    r"[ \t]*\}\n\n"
    r"[ \t]*return (?P=w)\.ToString\(\)\.Replace\(\"\\r\\n\", \"\\n\""
    r"(?P<cmp>, StringComparison\.Ordinal)?\);",
)

RESIDUE = re.compile(r"\.Evaluate\((?:new Dictionary<VariableSymbol, object>\(\)|variables)")

USING_LINE = re.compile(r"^using (?P<ns>[A-Za-z0-9_.]+);\s*$", re.MULTILINE)


def rewrite(text: str) -> tuple[str, dict[str, int]]:
    counts = {"T1": 0, "T2": 0, "T3": 0, "T4": 0, "T5": 0}

    def t1(match: re.Match) -> str:
        counts["T1"] += 1
        return f"EmittedOracle.Evaluate({match.group('arg1') or match.group('arg2')})"

    def t2(match: re.Match) -> str:
        counts["T2"] += 1
        return f"return EmittedOracle.Evaluate({match.group('arg1') or match.group('arg2')});"

    def t3(match: re.Match) -> str:
        counts["T3"] += 1
        return (
            f"private static EmittedOracleResult {match.group('name')}"
            f"(string {match.group('param')}){match.group('body')}"
        )

    def t5(match: re.Match) -> str:
        counts["T5"] += 1
        indent = match.group("ind")
        dedented = "".join(
            line[4:] if line.startswith("    ") else line
            for line in match.group("mid").splitlines(keepends=True)
        )
        comparison = match.group("cmp") or ""
        return (
            f"{indent}var result = EmittedOracle.Evaluate({match.group('src')});\n"
            f"{dedented}"
            f'{indent}return result.Output.Replace("\\r\\n", "\\n"{comparison});'
        )

    text = T5_CONSOLE_HELPER.sub(t5, text)
    text = T1_INLINE.sub(t1, text)
    text = T2_BLOCK.sub(t2, text)
    text = T3_RETYPE.sub(t3, text)

    if "EmittedOracle" in text and "using GSharp.Tests;" not in text and "namespace GSharp.Tests" not in text:
        text = insert_using(text, "GSharp.Tests")
        counts["T4"] += 1

    return text, counts


def insert_using(text: str, namespace: str) -> str:
    """Insert `using <namespace>;` keeping System-first alphabetical order."""
    usings = list(USING_LINE.finditer(text))
    if not usings:
        return text

    def key(ns: str) -> tuple[int, str]:
        return (0 if ns == "System" or ns.startswith("System.") else 1, ns)

    line = f"using {namespace};"
    for match in usings:
        if key(match.group("ns")) > key(namespace):
            return text[: match.start()] + line + "\n" + text[match.start():]

    last = usings[-1]
    return text[: last.end()] + "\n" + line + text[last.end():]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+")
    parser.add_argument("--dry-run", action="store_true", help="report without writing")
    args = parser.parse_args()

    residue_files = []
    for path in args.files:
        with open(path, encoding="utf-8") as handle:
            original = handle.read()

        text, counts = rewrite(original)
        applied = {k: v for k, v in counts.items() if v}
        if text != original and not args.dry_run:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(text)

        residues = len(RESIDUE.findall(text))
        if residues:
            residue_files.append((path, residues))

        summary = ", ".join(f"{k}x{v}" for k, v in applied.items()) or "no-op"
        print(f"{path}: {summary}" + (f", residue={residues}" if residues else ""))

    if residue_files:
        print("\nResidue needing hand-fix (Compilation-based .Evaluate call sites):", file=sys.stderr)
        for path, residues in residue_files:
            print(f"  {path}: {residues}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
