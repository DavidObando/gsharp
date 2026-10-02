#!/usr/bin/env python3
"""Regression tests for build/check-release-version-refs.py.

Each test edits one reference in memory (the checkout is never written) and
asserts the check reports it, so every part of the check is shown to fail
when it should (ADR-0154).
"""

from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location(
    "check_release_version_refs",
    REPO / "build" / "check-release-version-refs.py",
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/check-release-version-refs.py")
refs = importlib.util.module_from_spec(SPEC)
# dataclasses resolve string annotations through sys.modules.
sys.modules[SPEC.name] = refs
SPEC.loader.exec_module(refs)

BASE = refs.Tree(REPO)
RELEASE = json.loads(BASE.read(refs.RELEASE_JSON) or "{}")
if not isinstance(RELEASE, dict) or "version" not in RELEASE or "docsVersion" not in RELEASE:
    raise RuntimeError(f"{refs.RELEASE_JSON} must hold version and docsVersion; run the check for details")
VERSION = RELEASE["version"]
OTHER = "0.0.1"  # never a release, never allow-listed


class ReleaseVersionRefsTests(unittest.TestCase):
    def problems_with(self, edits: dict[str, str | None]) -> list[str]:
        return refs.check(refs.Tree(REPO, edits))

    def replaced(self, path: str, old: str, new: str) -> dict[str, str]:
        text = BASE.read(path)
        self.assertIsNotNone(text, f"{path} is missing")
        assert text is not None  # narrows the type; assertIsNotNone above reports the failure
        self.assertIn(old, text, f"{path} no longer contains {old!r}")
        return {path: text.replace(old, new)}

    def assertReported(self, problems: list[str], *fragments: str) -> None:
        self.assertTrue(
            any(all(f in p for f in fragments) for p in problems),
            f"no problem mentions {fragments}; got {problems}",
        )

    def test_checkout_agrees(self) -> None:
        self.assertEqual(self.problems_with({}), [])

    def test_stale_tracked_pin_is_reported(self) -> None:
        path = "samples/Trail/Trail.gsproj"
        problems = self.problems_with(self.replaced(
            path, f"Gsharp.NET.Sdk/{VERSION}", f"Gsharp.NET.Sdk/{OTHER}"))
        self.assertReported(problems, path, f"{OTHER} != release {VERSION}")

    def test_stale_prose_reference_is_reported(self) -> None:
        path = "website/docs/tutorials/trail.md"
        problems = self.problems_with(self.replaced(path, f"G# SDK {VERSION}", f"G# SDK {OTHER}"))
        self.assertReported(problems, path, OTHER)

    def test_stale_default_snapshot_prose_is_reported(self) -> None:
        root = f"website/versioned_docs/version-{RELEASE['docsVersion']}"
        cases = [
            (f"{root}/getting-started/install.md", f"published **{VERSION}**", f"published **{OTHER}**"),
            (f"{root}/tutorials/trail.md", f"G# SDK {VERSION}", f"G# SDK {OTHER}"),
            (f"{root}/release-notes.md", f"## {VERSION} at a glance", f"## {OTHER} at a glance"),
            (f"{root}/contributing/docs-authoring.md", f"against `v{VERSION}`", f"against `v{OTHER}`"),
        ]
        for path, old, new in cases:
            with self.subTest(path=path):
                problems = self.problems_with(self.replaced(path, old, new))
                self.assertReported(problems, path, f"{OTHER} != release {VERSION}")

    def test_every_default_snapshot_reference_is_checked(self) -> None:
        docs_version = RELEASE["docsVersion"]
        snapshot_entries = [e for e in refs.TRACKED if "{D}" in e.path]
        self.assertGreaterEqual(len(snapshot_entries), 10)
        for entry in snapshot_entries:
            path = entry.path.replace("{D}", docs_version)
            pattern = entry.pattern.replace("{V}", refs.VER)
            text = BASE.read(path)
            self.assertIsNotNone(text, f"{path} is missing")
            assert text is not None  # narrows the type; assertIsNotNone above reports the failure
            # Make only this entry's references stale; other refs stay current.
            stale = refs.re.sub(
                pattern, lambda m: m.group(0).replace(VERSION, OTHER), text, flags=refs.re.MULTILINE)
            self.assertNotEqual(stale, text, f"{path}: /{entry.pattern}/ matched nothing")
            with self.subTest(path=path, pattern=entry.pattern):
                self.assertReported(self.problems_with({path: stale}), path, f"{OTHER} != release {VERSION}")

    def test_reworded_tracked_reference_fails_instead_of_passing_vacuously(self) -> None:
        path = "website/docs/release-notes.md"
        problems = self.problems_with(self.replaced(
            path, f"The published **{VERSION}** release", "The current release"))
        self.assertReported(problems, path, "found 0")

    def test_missing_tracked_file_is_reported(self) -> None:
        problems = self.problems_with({"samples/ConcurrencyPatterns/README.md": None})
        self.assertReported(problems, "samples/ConcurrencyPatterns/README.md", "missing")

    def test_new_untracked_pin_is_reported(self) -> None:
        path = "website/docs/tooling/new-page.md"
        problems = self.problems_with({path: f"dotnet new install Gsharp.Templates::{OTHER}\n"})
        self.assertReported(problems, path, f"pins {OTHER}")

    def test_sweep_recognises_every_pin_spelling(self) -> None:
        spellings = [
            f'<Project Sdk="Gsharp.NET.Sdk/{OTHER}">',
            f'"Gsharp.NET.Sdk": "{OTHER}"',
            f"dotnet new install Gsharp.Templates::{OTHER}",
            f"dotnet tool install -g Gsharp.Gsfmt --version {OTHER}",
            f'<PackageReference Include="Gsharp.Repl" Version="{OTHER}" />',
            f"https://api.nuget.org/v3-flatcontainer/gsharp.cs2gs/{OTHER}/",
        ]
        for spelling in spellings:
            with self.subTest(spelling=spelling):
                problems = self.problems_with({"docs/pin-probe.md": spelling + "\n"})
                self.assertReported(problems, "docs/pin-probe.md", f"pins {OTHER}")

    def test_longer_version_is_not_read_as_the_release(self) -> None:
        for longer in (f"{VERSION}.1", f"{VERSION}-rc1", f"{VERSION}0"):
            with self.subTest(longer=longer):
                problems = self.problems_with({"docs/pin-probe.md": f'<Project Sdk="Gsharp.NET.Sdk/{longer}">\n'})
                self.assertReported(problems, "docs/pin-probe.md", f"pins {longer}")
                path = "samples/Trail/Trail.gsproj"
                problems = self.problems_with(self.replaced(
                    path, f"Gsharp.NET.Sdk/{VERSION}", f"Gsharp.NET.Sdk/{longer}"))
                self.assertReported(problems, path, f"{longer} != release {VERSION}")

    def test_sentence_ending_period_is_not_part_of_the_version(self) -> None:
        problems = self.problems_with({"docs/pin-probe.md": f"Pin Gsharp.NET.Sdk/{VERSION}.\n"})
        self.assertFalse([p for p in problems if "pin-probe" in p], problems)

    def test_allow_list_is_exact_about_versions(self) -> None:
        path = "src/vs-gsharp/templates/Project/Console/GSharpConsole.gsproj"
        pinned = "0.3.159"  # kept apart from the package id so the sweep does not read this file as a pin
        problems = self.problems_with(self.replaced(
            path, f"Gsharp.NET.Sdk/{pinned}", f"Gsharp.NET.Sdk/{OTHER}"))
        self.assertReported(problems, path, f"pins {OTHER}")

    def test_unused_allow_list_entry_is_reported(self) -> None:
        problems = self.problems_with({"samples/HotReload/global.json": None})
        self.assertReported(problems, "ALLOWED entry samples/HotReload/global.json", "matches nothing")

    def test_old_download_is_reported(self) -> None:
        name = f"{refs.DOWNLOADS}trail-{OTHER}.zip"
        problems = self.problems_with({name: ""})
        self.assertReported(problems, name, "delete it")

    def test_missing_download_is_reported(self) -> None:
        name = f"{refs.DOWNLOADS}concurrency-patterns-{VERSION}.zip"
        problems = self.problems_with({name: None})
        self.assertReported(problems, name, "missing")

    def test_invalid_json_is_reported_not_raised(self) -> None:
        for path in (refs.RELEASE_JSON, refs.VERSIONS_JSON):
            with self.subTest(path=path):
                self.assertReported(self.problems_with({path: "{ not json"}), path, "invalid JSON")

    def test_crlf_checkout_reads_like_lf(self) -> None:
        self.assertEqual(refs._scan("a\r\nGsharp.NET.Sdk/0.0.1\r\n"), (("0.0.1", 2),))
        root = REPO / "out" / "test-check-release-version-refs"
        root.mkdir(parents=True, exist_ok=True)
        try:
            (root / "notes.md").write_bytes(f"## {VERSION} at a glance\r\nnext\r\n".encode())
            text = refs._read(root, "notes.md")
            self.assertRegex(text or "", refs.re.compile(rf"^## {refs.re.escape(VERSION)} at a glance$",
                                                         refs.re.MULTILINE))
        finally:
            (root / "notes.md").unlink(missing_ok=True)
            root.rmdir()

    def test_release_json_tag_must_match_version(self) -> None:
        problems = self.problems_with(self.replaced(refs.RELEASE_JSON, f"v{VERSION}", f"v{OTHER}"))
        self.assertReported(problems, refs.RELEASE_JSON, "tag")

    def test_versions_json_must_lead_with_docs_version(self) -> None:
        problems = self.problems_with({refs.VERSIONS_JSON: json.dumps(["0.0"])})
        self.assertReported(problems, refs.VERSIONS_JSON, RELEASE["docsVersion"])

    def test_version_json_base_must_not_be_older_than_release(self) -> None:
        problems = self.problems_with(self.replaced(
            refs.VERSION_JSON, f'"version": "{RELEASE["docsVersion"]}"', '"version": "0.0"'))
        self.assertReported(problems, refs.VERSION_JSON, "older")

    def test_bumping_only_release_json_reports_every_tracked_reference(self) -> None:
        bumped = "999.0.1"
        release = dict(RELEASE, version=bumped, tag=f"v{bumped}", docsVersion="999.0")
        problems = self.problems_with({
            refs.RELEASE_JSON: json.dumps(release),
            refs.VERSIONS_JSON: json.dumps(["999.0", RELEASE["docsVersion"]]),
            refs.VERSION_JSON: '{ "version": "999.0" }',
        })
        for entry in refs.TRACKED:
            if "{D}" in entry.path:
                continue  # the 999.0 snapshot does not exist, reported as missing below
            with self.subTest(path=entry.path, pattern=entry.pattern):
                self.assertReported(problems, entry.path, VERSION)
        self.assertReported(problems, "website/versioned_docs/version-999.0/", "missing")


if __name__ == "__main__":
    unittest.main()
