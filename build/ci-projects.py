#!/usr/bin/env python3
"""Restore/build a selected project graph without building unrelated suites."""

import argparse
import json
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run(command, projects):
    allowed = {p.attrib["Path"] for p in ET.parse(ROOT / "GSharp.slnx").iter("Project")}
    selected = set(projects.split())
    if not selected or not selected.issubset(allowed):
        raise ValueError(f"invalid project selection: {sorted(selected.difference(allowed))}")
    solution_filter = {"solution": {"path": "GSharp.slnx", "projects": sorted(selected)}}
    # A native solution filter retains dependency configurations from the solution.
    # Close the temporary file before invoking dotnet so Windows does not hold an exclusive lock (#5085).
    with tempfile.NamedTemporaryFile(
            mode="w", dir=ROOT, prefix=".ci-projects-", suffix=".slnf", delete=False) as handle:
        json.dump(solution_filter, handle)
        filter_path = Path(handle.name)
    try:
        args = ["--locked-mode"] if command == "restore" else [
            "--configuration", "Release", "--no-restore", "-graph"]
        subprocess.run(["dotnet", command, str(filter_path), *args], cwd=ROOT, check=True)
    finally:
        filter_path.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["restore", "build"])
    parser.add_argument("--projects", required=True)
    args = parser.parse_args()
    run(args.command, args.projects)
