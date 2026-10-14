#!/usr/bin/env python3
"""Unit tests for build/check-publish-guard.py (the temporary stage-2 publish guard)."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("publish_guard", REPO / "build" / "check-publish-guard.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/check-publish-guard.py")
guard = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = guard
SPEC.loader.exec_module(guard)


TMP = tempfile.TemporaryDirectory(prefix="publish-guard-")  # removed at interpreter exit


def scratch() -> Path:
    return Path(tempfile.mkdtemp(dir=TMP.name))


def make_root(base: str = "0.4", pin: str = "0.4.1270") -> Path:
    root = scratch()
    (root / "version.json").write_text('{\n // c\n "version": "%s",\n "x": 1 }' % base, encoding="utf-8")
    (root / "global.json").write_text(json.dumps({"msbuild-sdks": {"Gsharp.NET.Sdk": pin}}), encoding="utf-8")
    return root


def make_zip(path: Path, files: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        for name, text in files.items():
            archive.writestr(name, text)


def run(*argv: str) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        status = guard.main(list(argv))
    return status, out.getvalue()


class PublishGuardTests(unittest.TestCase):
    def test_final_csharp_line_is_allowed(self) -> None:
        self.assertEqual(run("--root", str(make_root()))[0], 0)

    def test_malformed_versions_are_refused_but_real_forms_pass(self) -> None:
        for bad in ("0.4garbage", "0.4.1garbage", "0.4.", "0.4.1.2.3", "x0.4", "", "0.4 ", "0.4.1/x"):
            with self.subTest(bad=bad):
                self.assertTrue(guard.refuses(bad))
        for good in ("0.4", "0.4.1270", "0.4.1270-g1a2b3c", "0.4.1270.1", "0.4.1270+abc", "0.3.9"):
            with self.subTest(good=good):
                self.assertFalse(guard.refuses(good))
        for bad_base in ("0.4garbage", "0.4.1garbage"):
            self.assertEqual(run("--root", str(make_root(base=bad_base)))[0], 1)

    def test_older_line_is_allowed(self) -> None:
        self.assertEqual(guard.check_root(make_root(base="0.3", pin="0.4.1")), [])

    def test_version_base_05_is_refused_whatever_the_tag(self) -> None:
        status, output = run("--root", str(make_root(base="0.5")))
        self.assertEqual(status, 1)
        self.assertIn("version.json base is '0.5'", output)
        self.assertIn("Stage-2 publication gate", output)

    def test_unreadable_base_is_refused(self) -> None:
        root = make_root()
        (root / "version.json").write_text("{}", encoding="utf-8")
        self.assertEqual(run("--root", str(root))[0], 1)

    def test_source_built_or_stage_compiler_pin_is_refused(self) -> None:
        for pin in ("0.4.1270-geac5b487b1", "0.4.1270-stage1", "0.5.12", "0.4", ""):
            with self.subTest(pin=pin):
                self.assertEqual(run("--root", str(make_root(pin=pin)))[0], 1)

    def test_missing_files_are_refused(self) -> None:
        self.assertEqual(run("--root", str(scratch()))[0], 1)

    def test_05_package_is_refused_by_file_name_and_nuspec(self) -> None:
        root = make_root()
        out = scratch()
        make_zip(out / "Gsharp.NET.Sdk.0.5.3.nupkg", {"a.nuspec": "<package><version>0.5.3</version></package>"})
        make_zip(out / "Gsharp.Repl.0.4.9.nupkg", {"b.nuspec": "<package><version>0.5.0</version></package>"})
        status, output = run("--root", str(root), "--artifacts", str(out))
        self.assertEqual(status, 1)
        self.assertIn("Gsharp.NET.Sdk.0.5.3.nupkg", output)
        self.assertIn("nuspec version is 0.5.0", output)

    def test_05_vsix_is_refused(self) -> None:
        out = scratch()
        make_zip(out / "GSharp.VisualStudio.vsix",
                 {"extension.vsixmanifest": '<PackageManifest><Metadata><Identity Id="x" Version="0.5.7.1" /></Metadata></PackageManifest>'})
        make_zip(out / "vscode-gsharp.vsix", {"extension/package.json": '{"version": "0.5.7"}'})
        status, output = run("--root", str(make_root()), "--artifacts", str(out))
        self.assertEqual(status, 1)
        self.assertIn("vsixmanifest version is 0.5.7.1", output)
        self.assertIn("package.json version is 0.5.7", output)

    def test_04_artifacts_pass(self) -> None:
        out = scratch()
        make_zip(out / "Gsharp.NET.Sdk.0.4.1300.nupkg", {"a.nuspec": "<package><version>0.4.1300</version></package>"})
        make_zip(out / "vscode-gsharp.vsix", {"extension/package.json": '{"version": "0.4.1300"}'})
        self.assertEqual(run("--root", str(make_root()), "--artifacts", str(out))[0], 0)

    def test_missing_artifact_directory_is_refused(self) -> None:
        self.assertEqual(run("--root", str(make_root()), "--artifacts", "/nonexistent-dir-xyz")[0], 1)


if __name__ == "__main__":
    unittest.main()
