#!/usr/bin/env python3
"""TEMPORARY publish guard: refuse to publish a 0.5 or stage-2-built artifact.

docs/release/final-csharp-release.md, "Stage-2 publication gate", says a 0.5
artifact (emitted version base 0.5) or an artifact built by the stage-2
compiler MUST NOT publish until the evidence-bound certified publication is
wired into the `publish` job. Until then the `publish` and
`publish-visual-studio-extension` jobs of .github/workflows/build.yml run this
script first, whatever the tag text says.

It refuses when any of these holds:

  1. version.json's base is not the final C# line (0.4 or older), so every
     artifact the run built carries a 0.5+ version;
  2. global.json's Gsharp.NET.Sdk pin is not a plain published `0.4.N`
     release: a source-built (`-g<sha>`), `-stage1` or 0.5+ compiler built the
     artifacts;
  3. with --artifacts DIR, a downloaded .nupkg/.snupkg or .vsix names a 0.5+
     version (file name, nuspec, vsixmanifest or package.json).

Removal: delete this script, its test (build/test-check-publish-guard.py), every
"Refuse to publish a 0.5 or stage-2-built artifact" step in build.yml (two in
`publish`, one in `publish-visual-studio-extension`) and the test step in the
nullable-hygiene job, in the same change that wires the certified publication.

Usage: check-publish-guard.py [--root DIR] [--artifacts DIR]...
Exit status 0 when nothing is refused, 1 with one line per reason otherwise.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path

RUNBOOK = "docs/release/final-csharp-release.md, section 'Stage-2 publication gate'"
LAST_ALLOWED_LINE = (0, 4)
PLAIN_RELEASE = re.compile(r"^0\.4\.\d+$")
VERSION_FIELD = re.compile(r'"version"\s*:\s*"([^"]*)"')
NUPKG_VERSION = re.compile(r"\.(\d+)\.(\d+)\.\d+(?:[-+.][0-9A-Za-z.+-]*)?\.s?nupkg$")


# The whole string must be a version: 0.4, 0.4.N, the four-part VSIX form 0.4.N.R and an optional
# NuGet prerelease or build suffix. A prefix match would accept `0.4garbage`.
VERSION_SHAPE = re.compile(r"^(\d+)\.(\d+)(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")


def line_of(version: str) -> tuple[int, int] | None:
    match = VERSION_SHAPE.match(version)
    return (int(match.group(1)), int(match.group(2))) if match else None


def refuses(version: str) -> bool:
    """True when a version is not on the allowed (final C#) line, or unreadable."""
    parsed = line_of(version)
    return parsed is None or parsed > LAST_ALLOWED_LINE


def check_root(root: Path) -> list[str]:
    problems: list[str] = []
    version_json = root / "version.json"
    if not version_json.is_file():
        problems.append("version.json is missing")
    else:
        # version.json is JSON with comments, so read the one field directly.
        found = VERSION_FIELD.search(version_json.read_text(encoding="utf-8"))
        base = found.group(1) if found else ""
        if refuses(base):
            problems.append(f"version.json base is {base!r}: the emitted artifacts are version {base}.*, not the final C# line")
    global_json = root / "global.json"
    pin = ""
    if global_json.is_file():
        try:
            pin = json.loads(global_json.read_text(encoding="utf-8")).get("msbuild-sdks", {}).get("Gsharp.NET.Sdk", "")
        except (ValueError, AttributeError):
            pin = ""
    if not PLAIN_RELEASE.match(str(pin)):
        problems.append(f"global.json Gsharp.NET.Sdk pin is {pin!r}: not a published 0.4.N release, "
                        "so the artifacts may have been built by a source-built or stage-2 compiler")
    return problems


def zip_text(path: Path, name: str) -> str:
    try:
        with zipfile.ZipFile(path) as archive:
            for entry in archive.namelist():
                if entry == name or entry.endswith("/" + name) or (name.endswith("*") and entry.endswith(".nuspec")):
                    return archive.read(entry).decode("utf-8", "replace")
    except (zipfile.BadZipFile, OSError):
        return ""
    return ""


def check_artifacts(directory: Path) -> list[str]:
    problems: list[str] = []
    if not directory.is_dir():
        return [f"artifact directory {directory} does not exist"]
    for path in sorted(p for p in directory.rglob("*") if p.is_file()):
        name = path.name
        found = NUPKG_VERSION.search(name)
        if found and refuses(f"{found.group(1)}.{found.group(2)}"):
            problems.append(f"{path.name}: package version is on the {found.group(1)}.{found.group(2)} line")
        if name.endswith((".nupkg", ".snupkg")):
            nuspec = re.search(r"<version>([^<]*)</version>", zip_text(path, "*"))
            if nuspec and refuses(nuspec.group(1)):
                problems.append(f"{name}: nuspec version is {nuspec.group(1)}")
        elif name.endswith(".vsix"):
            manifest = re.search(r'<Identity[^>]*\sVersion="([^"]*)"', zip_text(path, "extension.vsixmanifest"))
            package = VERSION_FIELD.search(zip_text(path, "package.json"))
            for source, hit in (("vsixmanifest", manifest), ("package.json", package)):
                if hit and refuses(hit.group(1)):
                    problems.append(f"{name}: {source} version is {hit.group(1)}")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", default=Path(__file__).resolve().parent.parent, type=Path)
    parser.add_argument("--artifacts", action="append", default=[], type=Path)
    args = parser.parse_args(argv)
    problems = check_root(args.root)
    for directory in args.artifacts:
        problems.extend(check_artifacts(directory))
    if not problems:
        print("publish guard: nothing refused (final C# line, plain 0.4.N bootstrap SDK).")
        return 0
    print("::error::Publishing is refused: a 0.5 artifact or an artifact built by the stage-2 compiler "
          f"must not publish until the certified publication is wired in ({RUNBOOK}). "
          "This guard is temporary and is removed by the change that enables certified publication.")
    for problem in problems:
        print(f"  - {problem}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
