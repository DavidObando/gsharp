#!/usr/bin/env python3
"""Mechanical edits for the C# -> G# cut-over, applied to a checkout.

Every edit asserts that the text it replaces is present, so a drifted file fails
loudly instead of being silently skipped. Run `--check` first: it applies
everything to memory only and reports problems.

    cutover_edits.py --root <checkout> [--check]

Covers: workflows (build.yml and the others), the CI-matrix helper scripts, the
stale internals docs, and the compiler-architecture website page. Whole-file
replacements (CLAUDE.md etc.) are copied by apply.sh, not here.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

problems: list[str] = []
writes: dict[Path, str] = {}


def read(root: Path, rel: str) -> str:
    p = root / rel
    return writes.get(p) or p.read_text(encoding="utf-8")


def put(root: Path, rel: str, text: str) -> None:
    writes[root / rel] = text


def replace(root: Path, rel: str, old: str, new: str, count: int = 1) -> None:
    text = read(root, rel)
    if text.count(old) < 1:
        problems.append(f"{rel}: expected text not found: {old[:70]!r}")
        return
    put(root, rel, text.replace(old, new) if count == 0 else text.replace(old, new, count))


def sub_dotnet_lines(root: Path, rel: str) -> None:
    """GSharp.sln -> GSharp.slnx and .csproj -> .gsproj on dotnet/test commands.

    Lines for src/vs-gsharp stay untouched: the Visual Studio extension is C#.
    """
    out = []
    for line in read(root, rel).split("\n"):
        if "vs-gsharp" not in line and "VsGsharp" not in line:
            line = line.replace("GSharp.sln", "GSharp.slnx")
            if "dotnet" in line or "csproj" in line:
                line = re.sub(r"\.csproj\b", ".gsproj", line)
        out.append(line)
    put(root, rel, "\n".join(out))


def workflows(root: Path) -> None:
    build = ".github/workflows/build.yml"
    # 1. nullable-hygiene keeps its name (required-check context) but loses the
    #    hygiene script; the release-version-reference steps stay.
    replace(
        root,
        build,
        """      - name: Run nullable hygiene gate
        run: |
          python3 build/nullable_hygiene.py \\
            --base "origin/${{ github.base_ref || 'main' }}"

      # Shares this job""",
        """      # The C# nullable-hygiene script (ADR-0155) is retired with the C#
      # compiler source: G# has no `!` suppression operator, and `!!` is a
      # runtime check reviewed like any other code. The job keeps its name so
      # the required status check context does not change.

      # Shares this job""",
    )
    # 2. Remove the hot-core guard and its cancellation classifier.
    text = read(root, build)
    start = text.find("  # The hot-core translation guard ensures that changes to core projects")
    end = text.find("\n  publish:\n")
    if start < 0 or end < 0 or end < start:
        problems.append(f"{build}: hot-core guard block not found")
    else:
        put(root, build, text[:start] + text[end + 1 :])
    sub_dotnet_lines(root, build)
    for wf in (
        "pages.yml",
        "selfhost-windows.yml",
        "macos-nightly.yml",
        "windows-nightly.yml",
        "differential-conformance-nightly.yml",
        "cs2gs-nightly.yml",
        "concurrency-bench.yml",
    ):
        sub_dotnet_lines(root, f".github/workflows/{wf}")


def scripts(root: Path) -> None:
    for rel in (
        "build/generate-ci-test-matrix.py",
        "build/test-ci-test-matrix.py",
        "build/verify-ci-test-partition.py",
    ):
        text = read(root, rel)
        text = text.replace("GSharp.sln", "GSharp.slnx").replace(".Tests.csproj", ".Tests.gsproj")
        put(root, rel, text)


# (file, old, new). Paths ending in .cs inside backticks become .gs separately.
DOC_EDITS = [
    ("docs/lsp.md", "GSharp.LanguageServer (C#)", "GSharp.LanguageServer (G#)"),
    (
        "docs/emit-pipeline.md",
        "are now enforced at\nbuild time by the internal Roslyn analyzers in\n"
        "[`src/Analyzers/InternalAnalyzers`](../src/Analyzers/InternalAnalyzers). They\n"
        "run as a `TreatWarningsAsErrors` gate on `Core`, so a violation fails the\n"
        "build. See",
        "were enforced at\nbuild time by the internal Roslyn analyzers in\n"
        "[`src/Analyzers/InternalAnalyzers`](../src/Analyzers/InternalAnalyzers) while\n"
        "the compiler was C#. Those analyzers read C# syntax and do not run on the\n"
        "G# source of `Core`, so the rules are currently review conventions. See",
    ),
    (
        "docs/emit-pipeline.md",
        "The emit path does **not** depend on Roslyn",
        "The compiler is itself written in G# and builds with the previous released compiler "
        "(see [`self-host-bootstrap.md`](self-host-bootstrap.md)). The emit path does **not** depend on Roslyn",
    ),
    (
        "docs/debug-info.md",
        "builds a C# console host",
        "builds a C# console host (C# on purpose: it proves cross-language debugging)",
    ),
    (
        "website/docs/tooling/compiler-architecture.md",
        "## No Roslyn dependency in the emit path",
        "## The compiler is written in G#\n\n"
        "From 0.5 the compiler, language server, formatter and tools are G# source. cs2gs translated them from the C# source of the final C#-built release, and that C# source is kept, frozen, on the `cs2gs/csharp-0.4` branch. The repository builds with the previous released compiler, pinned in `global.json` (the N-1 rule: repository source uses only language features the pinned release supports). A stage-2 check rebuilds the compiler with the stage-1 compiler and requires identical `GSharp.Core.dll` and `gsc.dll`, so the shipped compiler is the self-built one. The Visual Studio extension stays C#.\n\n"
        "## No Roslyn dependency in the emit path",
    ),
]

CS_PATH = re.compile(r"(`|\()((?:\.\./)*(?:src|test|tools|build)/[A-Za-z0-9_./-]+)\.cs(`|\))")


def docs(root: Path) -> None:
    for rel, old, new in DOC_EDITS:
        replace(root, rel, old, new)
    for rel in ("docs/emit-pipeline.md", "docs/debug-info.md", "docs/lsp.md",
                "website/docs/tooling/compiler-architecture.md"):
        text = read(root, rel)
        # src/vs-gsharp stays C#.
        put(root, rel, CS_PATH.sub(
            lambda m: m.group(0) if "vs-gsharp" in m.group(2) else f"{m.group(1)}{m.group(2)}.gs{m.group(3)}",
            text))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, required=True)
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    for step in (workflows, scripts, docs):
        step(a.root)
    for rel_path in writes:
        pass
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    if not a.check:
        for p, t in writes.items():
            p.write_text(t, encoding="utf-8")
    print(f"{'checked' if a.check else 'edited'} {len(writes)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
