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
        # The Visual Studio extension and the ADR-0198 controller's C# helper
        # projects (build/selfhost/*.csproj) stay C# on purpose.
        if "vs-gsharp" not in line and "VsGsharp" not in line and "build/selfhost/" not in line:
            line = line.replace("GSharp.sln", "GSharp.slnx")
            if "dotnet" in line or "csproj" in line:
                line = re.sub(r"\.csproj\b", ".gsproj", line)
        out.append(line)
    put(root, rel, "\n".join(out))


def workflows(root: Path) -> None:
    build = ".github/workflows/build.yml"
    # 1. nullable-hygiene keeps its name (required-check context) but keeps the C#-scoped
    #    hygiene script (minus the Core coverage check) and the release-version steps.
    replace(
        root,
        build,
        """      - name: Run nullable hygiene gate
        run: |
          python3 build/nullable_hygiene.py \\
            --base "origin/${{ github.base_ref || 'main' }}"

      # Shares this job""",
        """      - name: Run nullable hygiene gate (remaining C# only)
        # After the cut-over the only production C# is src/vs-gsharp (plus test
        # fixtures and cs2gs inputs), which still enables nullable analysis.
        # Every check that scans tracked C# keeps running; `coverage` is
        # skipped because it asserts the shape of src/Core's C# files.
        run: |
          python3 build/nullable_hygiene.py \\
            --base "origin/${{ github.base_ref || 'main' }}" \\
            --check classify --check no-escapes --check suppressions \\
            --check null-bang --check arg-null-bang --check forgiving \\
            --check guard-added

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
    # Park selfhost-windows: dispatch-only. Its migrated-tree source (the
    # cs2gs-selfmig-nightly artifact) and its C# baseline no longer exist on
    # main, so it must neither run on PRs nor be rewritten to .gsproj.
    sw = ".github/workflows/selfhost-windows.yml"
    replace(
        root,
        sw,
        """  pull_request:
    paths:
      - '.github/workflows/selfhost-windows.yml'
      - 'build/selfhost-compare-trx.py'
      - 'build/test-selfhost-compare-trx.py'
""",
        "",
    )
    replace(
        root,
        sw,
        "name: selfhost-windows\n",
        "name: selfhost-windows\n\n# PARKED at the cut-over (owner decision 2026-10-09): dispatch-only, not gating.\n"
        "# It still expects a cs2gs-selfmig-nightly migrated tree and a C# Core.Tests\n"
        "# baseline, neither of which exists on main; repair it against branch\n"
        "# cs2gs/csharp-0.4 before relying on it.\n",
    )
    # 2b. cs2gs-nightly (strict corpus ledger) loses its Oahu legs: Oahu runs
    #     only in cs2gs-apps-nightly, and a legacy Oahu result must not keep
    #     this nightly red.
    cn = ".github/workflows/cs2gs-nightly.yml"
    text = read(root, cn)
    s1, e1 = text.find("      - name: Migrate and run pinned Oahu\n"), text.find("      - name: File issues for new gaps")
    s2, e2 = text.find("            cs2gs-oahu-pinned.log\n"), text.find("\n      - name: Report advisory and enforce gate outcome")
    s3 = text.find("      - name: Report advisory and enforce gate outcome")
    if min(s1, e1, s2, e2, s3) < 0 or not (s1 < e1 < s2 < e2 <= s3):
        problems.append(f"{cn}: Oahu blocks not found")
    else:
        tail_end = text.find("            exit 1\n          fi\n", s3)
        if tail_end < 0:
            problems.append(f"{cn}: gate outcome step not found")
        else:
            tail_end += len("            exit 1\n          fi\n")
            gate = (
                "      - name: Enforce gate outcome\n"
                "        run: |\n"
                "          if [[ \"${{ steps.migrate.outputs.migrate_exit }}\" != \"0\" ]]; then\n"
                "            exit 1\n"
                "          fi\n"
            )
            text = text[:s1] + text[e1:s2] + text[e2:s3] + gate + text[tail_end:]
            put(root, cn, text)
    # 2c. Run the apps-gate issue test in the PR checks.
    replace(
        root,
        build,
        "      - name: Verify the self-host compiler benchmark gate\n",
        "      - name: Verify the cs2gs apps gate issue logic\n"
        "        run: python3 build/test-cs2gs-apps-gate-issues.py\n\n"
        "      - name: Verify the self-host compiler benchmark gate\n",
    )
    # 2d. Fail closed: a tag must not publish unless the exact tagged commit has
    #     a successful stage-2 certification run (ADR-0198 section 11). The
    #     evidence/artifact-digest verification belongs to the controller; this
    #     is the minimum gate in the publish job itself.
    replace(
        root,
        build,
        "    permissions:\n      contents: write\n\n    steps:\n      - name: Download NuGet packages\n",
        "    permissions:\n      contents: write\n      actions: read\n\n    steps:\n"
        "      - name: Require stage-2 certification of the tagged commit\n"
        "        env:\n"
        "          GH_TOKEN: ${{ github.token }}\n"
        "        run: |\n"
        "          ok=$(gh run list --repo \"$GITHUB_REPOSITORY\" --workflow selfhost-stage2-nightly.yml \\\n"
        "            --commit \"$GITHUB_SHA\" --status success --json databaseId --jq 'length')\n"
        "          if [[ \"$ok\" == \"0\" ]]; then\n"
        "            echo \"::error::No successful selfhost-stage2-nightly run for $GITHUB_SHA. Dispatch it on the tagged commit first (ADR-0198).\"\n"
        "            exit 1\n"
        "          fi\n\n"
        "      - name: Download NuGet packages\n",
    )
    # 3. Oahu and Code Exploder move out of PR/official builds into the
    #    cs2gs-apps-nightly workflow; `publish` no longer waits for them.
    text = read(root, build)
    start = text.find("\n  cs2gs-oahu:\n")
    end = text.find("\n  vscode-extension:\n")
    if start < 0 or end < 0 or end < start:
        problems.append(f"{build}: cs2gs-oahu/cs2gs-code-exploder block not found")
    else:
        put(root, build, text[:start] + text[end:])
    replace(root, build, "cs2gs-corpus, cs2gs-oahu, cs2gs-code-exploder, vsix", "cs2gs-corpus, vsix")
    sub_dotnet_lines(root, build)
    for wf in (
        "pages.yml",
        "macos-nightly.yml",
        "windows-nightly.yml",
        "differential-conformance-nightly.yml",
        "cs2gs-nightly.yml",
        "concurrency-bench.yml",
    ):
        sub_dotnet_lines(root, f".github/workflows/{wf}")


SCRIPT_PRODUCT = re.compile(
    r"((?:src/(?:Sdk|Compiler|Core|Formatting|LanguageServer|Repl|GeneratorHost|Analyzers)|tools/(?:cs2gs|gsgen))/[A-Za-z0-9_./-]*?)\.csproj"
)


def stage2_controller(root: Path) -> None:
    """Retarget the one product project the ADR-0198 controller names.

    build/selfhost-stage2.py arrives with PR #4842 and is not edited there. Its
    C# helper projects (build/selfhost/PackageContentHash.csproj and
    TestSupervisorLogger.csproj) stay C#. Audit the controller for any other
    product .csproj path with: grep -n 'csproj' build/selfhost-stage2.py
    """
    rel = "build/selfhost-stage2.py"
    if not (root / rel).exists():
        print(f"note: {rel} not present; apply this edit after PR #4842 lands", file=sys.stderr)
        return
    text = read(root, rel)
    old = "src/Sdk/Gsharp.Extensions/Gsharp.Extensions.csproj"
    if old not in text:
        problems.append(f"{rel}: expected {old} not found")
        return
    put(root, rel, text.replace(old, old[: -len(".csproj")] + ".gsproj"))


REPO_ROOT_PROBE = '"GSharp.sln"'


def repo_root_probes(root: Path) -> None:
    """Repo-root anchors embedded in source: GSharp.sln no longer exists.

    Tests and cs2gs flows locate the repository by looking for the solution
    file. Rewrite the string literal in translated .gs files and in the
    Visual Studio extension's C# tests (which still run from the same root).
    """
    skip = {"out", "node_modules", "website", ".git", "bin", "obj"}
    files = [p for p in root.rglob("*.gs") if not skip & set(p.relative_to(root).parts)]
    vs = root / "src" / "vs-gsharp"
    if vs.exists():
        files += [p for p in vs.rglob("*.cs") if not skip & set(p.relative_to(root).parts)]
    for p in files:
        text = p.read_text(encoding="utf-8", errors="replace")
        if REPO_ROOT_PROBE in text:
            put(root, p.relative_to(root).as_posix(), text.replace(REPO_ROOT_PROBE, '"GSharp.slnx"'))


def scripts(root: Path) -> None:
    """Retarget the active shell scripts to the solution and product projects.

    RepositoryMirror copies non-source files verbatim, so these still name
    .csproj/.sln after translation. Only product projects under src/ are
    rewritten: fixture and host projects the scripts generate (Host.csproj,
    CSharpApp.csproj, inspect.csproj, SampleAnalyzer.csproj) are C# on purpose.
    """
    for rel in ["build/run-ilverify.sh", "build/selfmig-common.sh",
                "build/run-go2gs-prerequisite-spike.py", "build/generate-quality-dashboard.py",
                "tools/cs2gs/scripts/migrate-l1.sh", *sorted(p.relative_to(root).as_posix() for p in (root / "e2etests").glob("*.sh"))]:
        text = read(root, rel)
        new = SCRIPT_PRODUCT.sub(lambda m: m.group(1) + ".gsproj", text).replace("GSharp.sln", "GSharp.slnx")
        if new != text:
            put(root, rel, new)
    for rel in (
        "build/generate-ci-test-matrix.py",
        "build/test-ci-test-matrix.py",
        "build/verify-ci-test-partition.py",
    ):
        text = read(root, rel)
        # Includes the lowercase predicate in generate-ci-test-matrix.py.
        text = text.replace("GSharp.sln", "GSharp.slnx").replace(".csproj", ".gsproj").replace(".tests.csproj", ".tests.gsproj")
        put(root, rel, text)


# (file, old, new). Paths ending in .cs inside backticks become .gs separately.
DOC_EDITS = [
    ("docs/lsp.md", "GSharp.LanguageServer (C#)", "GSharp.LanguageServer (G#)"),
    ("tools/cs2gs/README.md", "dotnet build GSharp.sln -c Release -graph --no-restore",
     "dotnet build GSharp.slnx -c Release -graph --no-restore"),
    (
        "docs/emit-pipeline.md",
        "are now enforced at\nbuild time by the internal Roslyn analyzers in\n"
        "[`src/Analyzers/InternalAnalyzers`](../src/Analyzers/InternalAnalyzers). They\n"
        "run as a `TreatWarningsAsErrors` gate on `Core`, so a violation fails the\n"
        "build. See",
        "were enforced at\nbuild time by the internal Roslyn analyzers in\n"
        "[`src/Analyzers/InternalAnalyzers`](../src/Analyzers/InternalAnalyzers) while\n"
        "the compiler was C#. Those analyzers read C# syntax and do not run on the\n"
        "G# source of `Core`, so the rules were retired at the cut-over and are review conventions until"
        " G# equivalents exist. See",
    ),
    (
        "docs/self-host-bootstrap.md",
        "The compiler is moving to G# source.",
        "The compiler is written in G# source since the 0.5 cut-over "
        "(see [`self-migration-cutover.md`](self-migration-cutover.md)).",
    ),
    (
        "docs/self-host-bootstrap.md",
        "(today this repository's nupkg; at the cut-over the final released 0.4.x)",
        "(the release pinned in `global.json`; at the cut-over, the final released 0.4.x)",
    ),
    (
        "docs/self-host-bootstrap.md",
        "| the cs2gs-migrated G# tree | stage 0 |",
        "| the repository's G# source | stage 0 |",
    ),
    (
        "docs/self-host-bootstrap.md",
        "(manual dispatch; it also runs on pull requests that change it) does the following:",
        "(parked at the cut-over: manual dispatch only, not gating; the steps below describe the "
        "pre-cut-over procedure and need repair against `cs2gs/csharp-0.4` before reuse) does the following:",
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
        "From 0.5 the compiler, language server, formatter and tools are G# source. cs2gs translated them from the C# source of the final C#-built release, and that C# source is kept on the semi-frozen `cs2gs/csharp-0.4` branch, a living C# corpus for cs2gs (no fixes or features; occasional back-ports from G# when they exercise cs2gs). The repository builds with the previous released compiler, pinned in `global.json` (the N-1 rule: repository source uses only language features the pinned release supports). A stage-2 check rebuilds the compiler with the stage-1 compiler and requires identical `GSharp.Core.dll` and `gsc.dll`, so the shipped compiler is the self-built one. The Visual Studio extension stays C#.\n\n"
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
    for step in (workflows, scripts, stage2_controller, repo_root_probes, docs):
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
