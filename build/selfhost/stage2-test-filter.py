#!/usr/bin/env python3
"""Print the VSTest filter that runs a stage-2 test project minus its environment-bound tests."""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def build_filter(project: str) -> str:
    document = json.loads((HERE / "stage2-env-bound-tests.json").read_text(encoding="utf-8"))
    names = document.get(project)
    if not isinstance(names, list):
        raise SystemExit(f"stage2-test-filter: unknown test project {project!r}")
    return "&".join(f"FullyQualifiedName!={name}" for name in names)


if __name__ == "__main__":
    print(build_filter(sys.argv[1]))
