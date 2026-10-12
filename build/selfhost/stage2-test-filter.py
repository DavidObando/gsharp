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


def floors(projects: list[str]) -> list[str]:
    """Strictly loaded floors: exactly one positive integer per selected project."""
    document = json.loads((HERE / "stage2-test-floors.json").read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise SystemExit("stage2-test-filter: the floors file must be a JSON object")
    entries = {key: value for key, value in document.items() if key != "reason"}
    for key, value in entries.items():
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise SystemExit(f"stage2-test-filter: floor for {key!r} must be a positive integer")
    if set(entries) != set(projects):
        raise SystemExit(
            f"stage2-test-filter: floors {sorted(entries)} do not match the selected "
            f"projects {sorted(projects)}")
    return [f"{project}={entries[project]}" for project in projects]


if __name__ == "__main__":
    if sys.argv[1] == "floors":
        print("\n".join(floors(sys.argv[2:])))
    else:
        print(build_filter(sys.argv[1]))
