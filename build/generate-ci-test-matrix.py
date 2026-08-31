#!/usr/bin/env python3
"""Emit the GitHub Actions matrix for build.yml's ``tests`` job.

Every ``*.Tests.csproj`` in the solution gets a shard automatically, so a new
test project can never go unrun. Three of them are too big for one runner and
are split by test-name band; a handful are so small that a whole runner spends
three minutes of setup to run under a second of tests, and those share one.

**The shard table is declarative and the exclusions are derived.** A band is a
list of ``FullyQualifiedName`` substrings. Substring matching is not
prefix-free — ``Emit.Issue1`` also matches ``Emit.Issue10`` — so a band has to
exclude the bands that refine it, and hand-writing those ``&!~`` chains is how a
rebalance silently drops or double-runs a band. Here each band's exclusions are
computed from the table: every OTHER band's term that strictly extends one of
mine, minus the ones another exclusion already subsumes. Each sharded project
also gets exactly one ``remainder`` band, which excludes every minimal term in
the project, so a newly-added test class always lands somewhere without anyone
editing this file.

That gives disjointness structurally for the prefix relation, but substring
matching can still surprise (a class name containing two unrelated terms), so
``build/verify-ci-test-partition.py`` proves it empirically against the real
enumerated test list in CI. Rebalance by moving terms between bands here; the
verifier is what says whether the result is still a partition.

Band costs come from run 33429269051's trx artifacts (see the shard comments).
"""

import json
import re
import subprocess
import sys
from pathlib import Path


# Projects split into bands, each with the substrings that select the band.
# Exactly one band per project is the remainder and carries no terms.
SHARDED_PROJECTS = {
    "test/Compiler.Tests/Compiler.Tests.csproj": {
        # 43m of test time, the largest project in the repo.
        "conformance": ["GSharp.Compiler.Tests.LanguageConformance."],
        "issue1-remainder": ["GSharp.Compiler.Tests.Emit.Issue1"],
        "issue10-13": [
            "GSharp.Compiler.Tests.Emit.Issue10",
            "GSharp.Compiler.Tests.Emit.Issue11",
            "GSharp.Compiler.Tests.Emit.Issue12",
            "GSharp.Compiler.Tests.Emit.Issue13",
        ],
        "issue2-remainder": ["GSharp.Compiler.Tests.Emit.Issue2"],
        "issue20-24": [
            "GSharp.Compiler.Tests.Emit.Issue20",
            "GSharp.Compiler.Tests.Emit.Issue21",
            "GSharp.Compiler.Tests.Emit.Issue22",
            "GSharp.Compiler.Tests.Emit.Issue23",
            "GSharp.Compiler.Tests.Emit.Issue24",
        ],
        "issue5": ["GSharp.Compiler.Tests.Emit.Issue5"],
        "issue6": ["GSharp.Compiler.Tests.Emit.Issue6"],
        "issue7-9": [
            "GSharp.Compiler.Tests.Emit.Issue7",
            "GSharp.Compiler.Tests.Emit.Issue9",
        ],
        # Everything else under Emit — the old `compiler-remainder` was 14m,
        # over half of it here.
        "emit-remainder": ["GSharp.Compiler.Tests.Emit."],
        "remainder": [],
    },
    "tools/cs2gs/Cs2Gs.Tests/Cs2Gs.Tests.csproj": {
        # 29m. Issue33xx and Issue34xx are 9m of the old 17m remainder between
        # them (Issue3347RemainingSpillInventory alone is 4m).
        "issue1": ["Cs2Gs.Tests.Issue1"],
        "issue24": ["Cs2Gs.Tests.Issue24"],
        "issue25": ["Cs2Gs.Tests.Issue25"],
        "issue33": ["Cs2Gs.Tests.Issue33"],
        "issue34": ["Cs2Gs.Tests.Issue34"],
        "remainder": [],
    },
    "test/Core.Tests/Core.Tests.csproj": {
        # 8475 tests, 11.5m, previously one unsharded job. Binding is 75% of it.
        "binding": ["GSharp.Core.Tests.CodeAnalysis.Binding."],
        "remainder": [],
    },
}

# Projects whose whole suite runs in under a minute. Each was burning a runner's
# full three minutes of checkout/restore/build to do it; together they still
# make the cheapest shard in the matrix.
GROUPED_PROJECTS = (
    "test/Extensions.Tests/Extensions.Tests.csproj",
    "test/InternalAnalyzers.Tests/InternalAnalyzers.Tests.csproj",
    "test/LanguageServer.Tests/LanguageServer.Tests.csproj",
    "test/Sdk.Tests/Sdk.Tests.csproj",
    "tools/gsgen/GSharp.GeneratorHost.Tests/GSharp.GeneratorHost.Tests.csproj",
)

GROUPED_NAME = "fast-suites"

REMAINDER_BAND = "remainder"


def project_name(project: str) -> str:
    stem = Path(project).stem.removesuffix(".Tests")
    return re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")


def minimal(terms: list[str]) -> list[str]:
    """Drops terms that another term in the list already subsumes.

    ``Emit.Issue10`` is redundant next to ``Emit.Issue1``: anything the first
    matches, the second matches too. Keeping both would only make the filters
    longer and the intent harder to read.
    """
    return sorted(
        term for term in terms
        if not any(other != term and term.startswith(other) for other in terms)
    )


def band_filter(band: str, terms: list[str], project_bands: dict[str, list[str]]) -> str:
    """Builds one band's ``--filter`` expression from the project's table."""
    others = [
        term
        for name, band_terms in project_bands.items()
        if name != band
        for term in band_terms
    ]

    if band == REMAINDER_BAND:
        includes: list[str] = []
        excludes = minimal(others)
    else:
        includes = sorted(terms)
        # Only the bands that REFINE this one need excluding; a band that
        # matches something disjoint cannot steal a test from here.
        excludes = minimal([
            term for term in others
            if any(term != mine and term.startswith(mine) for mine in terms)
        ])

    clauses = [f"FullyQualifiedName~{term}" for term in includes]
    expression = "|".join(clauses)
    if len(clauses) > 1 and excludes:
        expression = f"({expression})"
    for term in excludes:
        expression = f"{expression}&FullyQualifiedName!~{term}" if expression \
            else f"FullyQualifiedName!~{term}"
    return expression


def sharded_entries(project: str, bands: dict[str, list[str]]) -> list[dict]:
    if REMAINDER_BAND not in bands:
        raise SystemExit(f"{project} has no '{REMAINDER_BAND}' band; new tests would go unrun.")
    if bands[REMAINDER_BAND]:
        raise SystemExit(f"{project}'s '{REMAINDER_BAND}' band must carry no terms.")

    prefix = project_name(project)
    return [
        {
            "name": f"{prefix}-{band}",
            "project": project,
            "filter": band_filter(band, terms, bands),
        }
        for band, terms in sorted(bands.items())
    ]


def main() -> int:
    solution = sys.argv[1] if len(sys.argv) > 1 else "GSharp.sln"
    result = subprocess.run(
        ["dotnet", "sln", solution, "list"],
        check=True,
        capture_output=True,
        text=True,
    )
    projects = sorted(
        line.strip().replace("\\", "/")
        for line in result.stdout.splitlines()
        if line.strip().lower().endswith(".tests.csproj")
    )

    missing = set(SHARDED_PROJECTS).union(GROUPED_PROJECTS).difference(projects)
    if missing:
        raise SystemExit(f"Missing sharded test projects: {sorted(missing)}")

    # Everything the table does not mention keeps its own shard, so adding a
    # test project to the solution is enough to get it run.
    entries = [
        {"name": project_name(project), "project": project, "filter": ""}
        for project in projects
        if project not in SHARDED_PROJECTS and project not in GROUPED_PROJECTS
    ]
    entries.append({
        "name": GROUPED_NAME,
        "project": " ".join(GROUPED_PROJECTS),
        "filter": "",
    })
    for project, bands in SHARDED_PROJECTS.items():
        entries.extend(sharded_entries(project, bands))

    names = [entry["name"] for entry in entries]
    if len(names) != len(set(names)):
        raise SystemExit("Generated test matrix contains duplicate names.")

    entries.sort(key=lambda entry: entry["name"])
    print(json.dumps({"include": entries}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
