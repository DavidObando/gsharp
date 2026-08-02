#!/usr/bin/env python3

import json
import re
import subprocess
import sys
from pathlib import Path


SPECIAL_PROJECTS = {
    "test/Compiler.Tests/Compiler.Tests.csproj",
    "tools/cs2gs/Cs2Gs.Tests/Cs2Gs.Tests.csproj",
}


def project_name(project: str) -> str:
    stem = Path(project).stem.removesuffix(".Tests")
    return re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")


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

    missing = SPECIAL_PROJECTS.difference(projects)
    if missing:
        raise SystemExit(f"Missing sharded test projects: {sorted(missing)}")

    entries = [
        {"name": project_name(project), "project": project, "filter": ""}
        for project in projects
        if project not in SPECIAL_PROJECTS
    ]
    entries.extend(
        [
            {
                "name": "compiler-issue10-13",
                "project": "test/Compiler.Tests/Compiler.Tests.csproj",
                "filter": "FullyQualifiedName~GSharp.Compiler.Tests.Emit.Issue10|FullyQualifiedName~GSharp.Compiler.Tests.Emit.Issue11|FullyQualifiedName~GSharp.Compiler.Tests.Emit.Issue12|FullyQualifiedName~GSharp.Compiler.Tests.Emit.Issue13",
            },
            {
                "name": "compiler-issue1-remainder",
                "project": "test/Compiler.Tests/Compiler.Tests.csproj",
                "filter": "FullyQualifiedName~GSharp.Compiler.Tests.Emit.Issue1&FullyQualifiedName!~GSharp.Compiler.Tests.Emit.Issue10&FullyQualifiedName!~GSharp.Compiler.Tests.Emit.Issue11&FullyQualifiedName!~GSharp.Compiler.Tests.Emit.Issue12&FullyQualifiedName!~GSharp.Compiler.Tests.Emit.Issue13",
            },
            {
                "name": "compiler-issue20-24",
                "project": "test/Compiler.Tests/Compiler.Tests.csproj",
                "filter": "FullyQualifiedName~GSharp.Compiler.Tests.Emit.Issue20|FullyQualifiedName~GSharp.Compiler.Tests.Emit.Issue21|FullyQualifiedName~GSharp.Compiler.Tests.Emit.Issue22|FullyQualifiedName~GSharp.Compiler.Tests.Emit.Issue23|FullyQualifiedName~GSharp.Compiler.Tests.Emit.Issue24",
            },
            {
                "name": "compiler-issue2-remainder",
                "project": "test/Compiler.Tests/Compiler.Tests.csproj",
                "filter": "FullyQualifiedName~GSharp.Compiler.Tests.Emit.Issue2&FullyQualifiedName!~GSharp.Compiler.Tests.Emit.Issue20&FullyQualifiedName!~GSharp.Compiler.Tests.Emit.Issue21&FullyQualifiedName!~GSharp.Compiler.Tests.Emit.Issue22&FullyQualifiedName!~GSharp.Compiler.Tests.Emit.Issue23&FullyQualifiedName!~GSharp.Compiler.Tests.Emit.Issue24",
            },
            {
                "name": "compiler-issue5",
                "project": "test/Compiler.Tests/Compiler.Tests.csproj",
                "filter": "FullyQualifiedName~GSharp.Compiler.Tests.Emit.Issue5",
            },
            {
                "name": "compiler-issue6",
                "project": "test/Compiler.Tests/Compiler.Tests.csproj",
                "filter": "FullyQualifiedName~GSharp.Compiler.Tests.Emit.Issue6",
            },
            {
                "name": "compiler-issue7-9",
                "project": "test/Compiler.Tests/Compiler.Tests.csproj",
                "filter": "FullyQualifiedName~GSharp.Compiler.Tests.Emit.Issue7|FullyQualifiedName~GSharp.Compiler.Tests.Emit.Issue9",
            },
            {
                "name": "compiler-remainder",
                "project": "test/Compiler.Tests/Compiler.Tests.csproj",
                "filter": "FullyQualifiedName!~GSharp.Compiler.Tests.Emit.Issue1&FullyQualifiedName!~GSharp.Compiler.Tests.Emit.Issue2&FullyQualifiedName!~GSharp.Compiler.Tests.Emit.Issue5&FullyQualifiedName!~GSharp.Compiler.Tests.Emit.Issue6&FullyQualifiedName!~GSharp.Compiler.Tests.Emit.Issue7&FullyQualifiedName!~GSharp.Compiler.Tests.Emit.Issue9",
            },
            {
                "name": "cs2gs-issue25",
                "project": "tools/cs2gs/Cs2Gs.Tests/Cs2Gs.Tests.csproj",
                "filter": "FullyQualifiedName~Cs2Gs.Tests.Issue25",
            },
            {
                "name": "cs2gs-issue24",
                "project": "tools/cs2gs/Cs2Gs.Tests/Cs2Gs.Tests.csproj",
                "filter": "FullyQualifiedName~Cs2Gs.Tests.Issue24",
            },
            {
                "name": "cs2gs-issue1",
                "project": "tools/cs2gs/Cs2Gs.Tests/Cs2Gs.Tests.csproj",
                "filter": "FullyQualifiedName~Cs2Gs.Tests.Issue1",
            },
            {
                "name": "cs2gs-remainder",
                "project": "tools/cs2gs/Cs2Gs.Tests/Cs2Gs.Tests.csproj",
                "filter": "FullyQualifiedName!~Cs2Gs.Tests.Issue25&FullyQualifiedName!~Cs2Gs.Tests.Issue24&FullyQualifiedName!~Cs2Gs.Tests.Issue1",
            },
        ]
    )

    names = [entry["name"] for entry in entries]
    if len(names) != len(set(names)):
        raise SystemExit("Generated test matrix contains duplicate names.")

    print(json.dumps({"include": entries}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
