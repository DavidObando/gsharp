#!/usr/bin/env python3
"""Check that every reference to "the latest published release" agrees.

A G# release version lives in many hand-edited places: the website's install
page, the Trail tutorial and its downloadable zip, the showcase samples' SDK
pins, the evidence JSON the website tests read, and copy-paste examples in the
docs. Nothing tied them together outside the website's own content tests (which
only run when `website/**` or `samples/**` changes, and only cover part of the
set), so a release bump that missed one left a stale pin behind.

Source of truth: `website/src/data/release.json` `version`. It is the value
the website renders, the value `website/scripts/prepare-showcase.py` and the
`website/tests/verify-*.py` checks restore from nuget.org, and it only changes
in the post-publish docs PR (docs/release/version-bump-checklist.md). The newest
`v*` Git tag is NOT used: a tag is pushed before that docs PR can land (the
website verifiers need the package on nuget.org first), so comparing against
the tag would turn every PR red during the release window.

The check has four parts:

  1. structure  release.json is self-consistent (tag == "v" + version, the
                version belongs to docsVersion), versions.json's newest
                snapshot is docsVersion, and version.json's base is not older.
  2. tracked    Each entry in TRACKED names a file and a pattern for a
                reference that must equal the release version, with a minimum
                match count so a moved file or reworded sentence fails loudly
                instead of passing vacuously.
  3. sweep      Every tracked text file in the repository is scanned for a
                package-qualified version pin (`Gsharp.NET.Sdk/X`,
                `Gsharp.Templates::X`, `"Gsharp.NET.Sdk": "X"`, ...). A pin to
                any other version must be covered by an ALLOWED entry naming
                the path, the exact version and the reason it is intentionally
                not the latest release. An ALLOWED entry that matches nothing
                is itself an error, so the list cannot rot.
  4. downloads  website/static/downloads holds exactly the release's Trail and
                concurrency-pattern zips, no older ones.

Usage: check-release-version-refs.py [--root DIR]

Exit status 0 when everything agrees, 1 with one line per finding otherwise.
build/test-check-release-version-refs.py proves each part can fail.
"""

from __future__ import annotations

import argparse
import fnmatch
import functools
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

CHECKLIST = "docs/release/version-bump-checklist.md"
RELEASE_JSON = "website/src/data/release.json"
VERSIONS_JSON = "website/versions.json"
VERSION_JSON = "version.json"
DOWNLOADS = "website/static/downloads/"

# A whole NuGet version token: three or four numeric parts and an optional
# prerelease suffix ending in an alphanumeric. Matching the whole token matters:
# `0.4.591.1` must be read as itself, not accepted as its `0.4.591` prefix, and
# a sentence-ending `0.4.591.` must still read as `0.4.591`.
VER = r"\d+(?:\.\d+){2,3}(?:-[0-9A-Za-z](?:[0-9A-Za-z.-]*[0-9A-Za-z])?)?"

# Package-qualified pins. Each alternative separates a published package id
# from a version the way a project file, global.json, a template install, a
# tool install or a PackageReference does.
PIN = re.compile(
    r"(?i)\bgsharp\.(?:net\.sdk|templates|repl|gsfmt|cs2gs|codeanalysis\.analyzers\.testing)"
    r"(?:\s*/\s*|::|\"\s*:\s*\"|\"\s+version=\"|\s+--version\s+)"
    r"(?P<v>" + VER + r")"
)


@dataclass(frozen=True)
class Tracked:
    """A reference that must equal the release version.

    ``pattern`` is a regex with one capture group for the version; ``{V}`` in
    it expands to VER. ``path`` may contain ``{D}``, the docs version.
    """

    path: str
    pattern: str
    minimum: int
    why: str


@dataclass(frozen=True)
class Allowed:
    """A package-qualified pin that intentionally is not the latest release."""

    glob: str
    versions: frozenset[str]  # empty set means "any version"
    why: str


# Pages whose release references must agree in both the development docs
# (website/docs) and the default released snapshot
# (website/versioned_docs/version-<docsVersion>): the snapshot is what /docs
# serves, so a stale reference there is the one most readers see.
DOC_PAGES: tuple[tuple[str, str, str], ...] = (
    ("getting-started/install.md", r"published \*\*({V})\*\*",
     "install page names the release it installs"),
    ("getting-started/install.md", r"Gsharp\.Templates::({V})", "template install command"),
    ("getting-started/install.md", r"Gsharp\.NET\.Sdk/({V})", "project-file example"),
    ("tutorials/trail.md", r"G# SDK ({V})", "Trail verified-example banner"),
    ("tutorials/trail.md", r"Trail for SDK ({V})", "Trail download link text"),
    ("tutorials/trail.md", r"/downloads/trail-({V})\.zip", "Trail download link target"),
    ("tooling/sdk-projects.md", r"\"Gsharp\.NET\.Sdk\":\s*\"({V})\"", "global.json pin example"),
    ("contributing/docs-authoring.md", r"refreshed against `v({V})`",
     "names the tag the default snapshot was refreshed from"),
)

TRACKED: tuple[Tracked, ...] = (
    *(Tracked(f"{root}/{page}", pattern, 1, f"{label}: {why}")
      for root, label in (("website/docs", "docs"),
                          ("website/versioned_docs/version-{D}", "default snapshot"))
      for page, pattern, why in DOC_PAGES),
    Tracked("website/docs/release-notes.md", r"The published \*\*({V})\*\* release", 1,
            "release notes name the release the website installs"),
    Tracked("website/versioned_docs/version-{D}/release-notes.md", r"^## ({V}) at a glance$", 1,
            "default snapshot release notes are headed by their release"),
    Tracked("website/versioned_docs/version-{D}/release-notes.md",
            r"follows the published `v({V})` Git tag", 1,
            "default snapshot names its source tag"),
    Tracked("website/README.md", r"refreshed from `v({V})`", 1,
            "names the tag the default snapshot was refreshed from"),
    Tracked("website/static/data/concurrency-checks.json", r"\"sdkVersion\":\s*\"({V})\"", 1,
            "evidence from website/tests/verify-concurrency-patterns.py"),
    Tracked("website/static/img/trail-editor.json", r"\"applicationSdk\":\s*\"({V})\"", 1,
            "Trail editor capture: the SDK the application used"),
    Tracked("website/static/img/trail-editor.json",
            r"\"extension\":\s*\"gsharplang\.vscode-gsharp ({V})\"", 1,
            "Trail editor capture: the VS Code extension it was taken with"),
    Tracked("samples/Trail/Trail.gsproj", r"Sdk=\"Gsharp\.NET\.Sdk/({V})\"", 1,
            "packaged into the Trail download"),
    Tracked("samples/ConcurrencyPatterns/gsharp/Patterns.gsproj",
            r"Sdk=\"Gsharp\.NET\.Sdk/({V})\"", 1, "packaged into the patterns download"),
    Tracked("samples/ConcurrencyPatterns/README.md", r"`Gsharp\.NET\.Sdk/({V})`", 1,
            "packaged into the patterns download"),
    Tracked("docs/sdk-usage.md", r"\"Gsharp\.NET\.Sdk\":\s*\"({V})\"", 1,
            "global.json pin example"),
)

ALLOWED: tuple[Allowed, ...] = (
    Allowed("website/versioned_docs/*", frozenset(),
            "released documentation snapshots keep the commands of their own release; "
            "the default snapshot's release-facing refs are TRACKED separately"),
    Allowed("src/vs-gsharp/templates/Project/*", frozenset({"0.3.159"}),
            "placeholder: VsGsharp.csproj's BuildGSharpTemplates target XmlPokes "
            "Sdk=\"Gsharp.NET.Sdk/$(NuGetPackageVersion)\" into every template at VSIX build"),
    Allowed("src/vs-gsharp/test/ProjectDebugFixtures/*", frozenset({"0.3.159"}),
            "Visual Studio debug fixtures pinned to a published SDK on purpose"),
    Allowed("src/vs-gsharp/test/TestExplorerFixtures/*", frozenset({"0.3.159"}),
            "Test Explorer fixtures pinned to a published SDK on purpose; "
            "TestExplorerFixtureContractTests asserts the pin"),
    Allowed("src/vs-gsharp/test/VsGsharp.UnitTests/TestExplorerFixtureContractTests.cs",
            frozenset({"0.3.159"}), "the contract test that asserts the fixture pin"),
    Allowed("src/vscode-gsharp/test/live/suite/index.js", frozenset({"0.3.159"}),
            "live VS Code test project, pinned with the Test Explorer fixtures"),
    Allowed("samples/HotReload/global.json", frozenset({"0.3.356"}),
            "placeholder: e2etests/hot-reload-e2e.sh rewrites it to the locally built "
            "SDK and restores it on exit"),
    Allowed("tools/cs2gs/Cs2Gs.Tests/*", frozenset(),
            "synthetic versions in cs2gs project-transformer test data"),
)

SKIPPED_SUFFIXES = (".lock.json", "package-lock.json", ".zip", ".png", ".jpg", ".jpeg",
                    ".gif", ".ico", ".webp", ".woff", ".woff2", ".ttf", ".nupkg", ".dll",
                    ".snk", ".pdf")


@dataclass
class Tree:
    """The files to check: a checkout, optionally with in-memory edits.

    ``overlay`` maps a repo-relative path to replacement text, or to None to
    delete it; paths not in the checkout are added. The tests use it to
    mutate one reference at a time without touching the working tree.
    """

    root: Path
    overlay: dict[str, str | None] = field(default_factory=dict)

    def paths(self) -> list[str]:
        result = set(_listed(self.root))
        for path, text in self.overlay.items():
            if text is None:
                result.discard(path)
            else:
                result.add(path)
        return sorted(result)

    def read(self, path: str) -> str | None:
        if path in self.overlay:
            return self.overlay[path]
        return _read(self.root, path)

    def pins(self, path: str) -> tuple[tuple[str, int], ...]:
        """(version, line) of every package-qualified pin in the file."""
        if path in self.overlay:
            return _scan(self.overlay[path])
        return _pins(self.root, path)


def _scan(text: str | None) -> tuple[tuple[str, int], ...]:
    if text is None:
        return ()
    return tuple((m.group("v"), line_of(text, m.start("v"))) for m in PIN.finditer(text))


@functools.cache
def _pins(root: Path, path: str) -> tuple[tuple[str, int], ...]:
    return _scan(_read(root, path))


@functools.cache
def _listed(root: Path) -> tuple[str, ...]:
    listed = subprocess.run(
        ["git", "ls-files", "-z"], cwd=root, check=True, capture_output=True
    ).stdout.decode("utf-8").split("\0")
    return tuple(p for p in listed if p and (root / p).is_file())


@functools.cache
def _read(root: Path, path: str) -> str | None:
    """Text of a checkout file, or None when it is missing or binary."""
    file = root / path
    if not file.is_file():
        return None
    data = file.read_bytes()
    if b"\0" in data[:8192]:
        return None
    # Normalise CRLF so `$`-anchored patterns behave the same on a Windows checkout.
    return data.decode("utf-8", errors="replace").replace("\r\n", "\n")


def line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def major_minor(version: str) -> tuple[int, int]:
    parts = version.split(".")
    return int(parts[0]), int(parts[1])


def check(tree: Tree) -> list[str]:
    problems: list[str] = []

    release_text = tree.read(RELEASE_JSON)
    if release_text is None:
        return [f"{RELEASE_JSON}: missing; it is the source of truth for the release version"]
    try:
        release = json.loads(release_text)
    except json.JSONDecodeError as error:
        return [f"{RELEASE_JSON}: invalid JSON: {error}"]
    if not isinstance(release, dict):
        return [f"{RELEASE_JSON}: expected a JSON object"]
    version = str(release.get("version", ""))
    docs_version = str(release.get("docsVersion", ""))
    if not re.fullmatch(VER, version):
        return [f"{RELEASE_JSON}: version {version!r} is not a NuGet version"]

    # 1. structure
    if release.get("tag") != f"v{version}":
        problems.append(f"{RELEASE_JSON}: tag {release.get('tag')!r} != 'v{version}'")
    if not version.startswith(docs_version + "."):
        problems.append(
            f"{RELEASE_JSON}: version {version} does not belong to docsVersion {docs_version!r}")
    versions_text = tree.read(VERSIONS_JSON)
    try:
        versions = json.loads(versions_text) if versions_text else []
    except json.JSONDecodeError as error:
        problems.append(f"{VERSIONS_JSON}: invalid JSON: {error}")
        versions = None
    if versions is None:
        pass
    elif not isinstance(versions, list) or not versions or versions[0] != docs_version:
        problems.append(
            f"{VERSIONS_JSON}: newest snapshot {versions[:1]} != release docsVersion {docs_version!r}")
    version_json = tree.read(VERSION_JSON)
    if version_json is None:
        problems.append(f"{VERSION_JSON}: missing")
    else:
        # version.json is JSON with comments, so read the one field directly.
        found = re.search(r'"version"\s*:\s*"([^"]*)"', version_json)
        base = found.group(1) if found else ""
        if not re.fullmatch(r"\d+\.\d+", base) or major_minor(base) < major_minor(version):
            problems.append(
                f"{VERSION_JSON}: version base {base!r} is older than the released {version}")

    # 2. tracked references
    for entry in TRACKED:
        path = entry.path.replace("{D}", docs_version)
        text = tree.read(path)
        if text is None:
            problems.append(f"{path}: missing (tracked: {entry.why})")
            continue
        pattern = re.compile(entry.pattern.replace("{V}", VER), re.MULTILINE)
        matches = list(pattern.finditer(text))
        if len(matches) < entry.minimum:
            problems.append(
                f"{path}: expected at least {entry.minimum} match(es) of /{entry.pattern}/, "
                f"found {len(matches)} (tracked: {entry.why})")
        for match in matches:
            if match.group(1) != version:
                problems.append(
                    f"{path}:{line_of(text, match.start(1))}: {match.group(1)} != release "
                    f"{version} ({entry.why})")

    # 3. sweep for package-qualified pins
    used: set[Allowed] = set()
    paths = tree.paths()
    for path in paths:
        if path.endswith(SKIPPED_SUFFIXES):
            continue
        for found, line in tree.pins(path):
            if found == version:
                continue
            allowed = next(
                (a for a in ALLOWED
                 if fnmatch.fnmatchcase(path, a.glob) and (not a.versions or found in a.versions)),
                None)
            if allowed is None:
                problems.append(
                    f"{path}:{line}: pins {found}, release is "
                    f"{version}; update it or add an ALLOWED entry with the reason")
            else:
                used.add(allowed)
    for entry in ALLOWED:
        if entry not in used:
            problems.append(
                f"build/check-release-version-refs.py: ALLOWED entry {entry.glob} "
                f"{sorted(entry.versions) or '(any)'} matches nothing; remove it")

    # 4. downloads
    zip_pattern = re.compile(r"(trail|concurrency-patterns)-(" + VER + r")\.zip")
    downloads = {p[len(DOWNLOADS):] for p in paths if p.startswith(DOWNLOADS)}
    expected = {f"trail-{version}.zip", f"concurrency-patterns-{version}.zip"}
    for name in sorted(expected - downloads):
        problems.append(f"{DOWNLOADS}{name}: missing (website/scripts/prepare-showcase.py writes it)")
    for name in sorted(downloads - expected):
        if zip_pattern.fullmatch(name):
            problems.append(f"{DOWNLOADS}{name}: download for a release other than {version}; delete it")

    return problems


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args(argv)
    tree = Tree(args.root.resolve())
    problems = check(tree)
    found = re.search(r'"version"\s*:\s*"([^"]*)"', tree.read(RELEASE_JSON) or "")
    release = found.group(1) if found else "?"
    if problems:
        print(f"Release version references disagree with {RELEASE_JSON} ({release}):")
        for problem in problems:
            print(f"  {problem}")
        print(f"See {CHECKLIST} for what to edit in a release.")
        return 1
    print(f"Release version references agree: {release} "
          f"({len(TRACKED)} tracked references, {len(ALLOWED)} allow-list entries).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
