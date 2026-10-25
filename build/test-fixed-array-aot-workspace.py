#!/usr/bin/env python3
"""Exercise the real AOT driver's artifact-root guard without builds or writes."""

from contextlib import redirect_stderr, redirect_stdout
import importlib.util
from io import StringIO
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch
import uuid


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "e2etests/fixed-array-abi-aot.py"
spec = importlib.util.spec_from_file_location("fixed_array_aot", SCRIPT)
aot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(aot)
PIN = json.loads((ROOT / "global.json").read_text())


class WorkspaceTests(unittest.TestCase):
    def invoke(self, arguments, *, rejected):
        with (
            patch.object(sys, "argv", [str(SCRIPT), *arguments]),
            patch.object(Path, "mkdir") as mkdir,
            patch.object(Path, "write_text") as write,
            patch.object(Path, "is_file", return_value=True),
            patch.object(Path, "read_text", return_value=json.dumps(PIN)),
            patch.object(Path, "read_bytes", return_value=b"compiler fixture"),
            patch.object(aot.platform, "platform", return_value="fixture host"),
            patch.object(aot.platform, "machine", return_value="fixture architecture"),
            patch.object(aot.os, "environ", {"NUGET_PACKAGES": str(ROOT / "out/test-artifacts/mock-packages")}),
            patch.object(subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 1, "", "deliberate mocked owner-build stop"
            )) as run,
            redirect_stderr(StringIO()),
            redirect_stdout(StringIO()),
        ):
            if rejected:
                with self.assertRaises(SystemExit) as error:
                    aot.main()
                self.assertEqual(error.exception.code, 2)
                mkdir.assert_not_called()
                write.assert_not_called()
                run.assert_not_called()
            else:
                self.assertEqual(aot.main(), 1)
                self.assertEqual(run.call_count, 1)
                self.assertEqual(run.call_args.args[0][:3], [
                    "dotnet", "build", "src/Sdk/Gsharp.Runtime.Values/Gsharp.Runtime.Values.gsproj"
                ])
                return Path(run.call_args.kwargs["env"]["TMPDIR"])

    def test_checkout_and_protected_trees_reject_before_effects(self):
        for value in [ROOT, ROOT / "src", ROOT / "test", ROOT / "build", ROOT / ".git",
                      ROOT / "e2etests", ROOT / "website", ROOT / "out/bin", ROOT.parent]:
            with self.subTest(work=str(value)):
                self.invoke(["--work", str(value)], rejected=True)

    def test_shared_artifact_root_and_parent_escape_reject_before_effects(self):
        for value in [ROOT / "out/test-artifacts", ROOT / "out/test-artifacts/../bin"]:
            with self.subTest(work=str(value)):
                self.invoke(["--work", str(value)], rejected=True)

    def test_default_and_dedicated_artifact_directory_reach_owner_build(self):
        artifact_root = ROOT / "out/test-artifacts"
        self.assertEqual(self.invoke([], rejected=False), artifact_root / "fixed-array-f1-aot")
        chosen = artifact_root / "guard-positive"
        self.assertEqual(self.invoke(["--work", str(chosen)], rejected=False), chosen)

    def test_symlink_escape_and_nested_output_alias_reject_before_effects(self):
        fixture = ROOT / "out/test-artifacts" / ("aot-guard-" + uuid.uuid4().hex)
        fixture.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, fixture)
        link = fixture / "Producer"
        try:
            link.symlink_to(ROOT / "src", target_is_directory=True)
        except OSError as error:
            self.skipTest(f"directory symlinks unavailable: {error}")
        for value in [link, fixture]:
            with self.subTest(work=str(value)):
                self.invoke(["--work", str(value)], rejected=True)

    def test_symlinked_artifact_parent_cannot_expand_allowed_tree(self):
        fixture = ROOT / "out/test-artifacts" / ("aot-guard-" + uuid.uuid4().hex)
        checkout = fixture / "checkout"
        protected = checkout / "protected"
        protected.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, fixture)
        try:
            (checkout / "out").symlink_to(protected, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"directory symlinks unavailable: {error}")
        with patch.object(aot, "ROOT", checkout):
            self.invoke(["--work", str(checkout / "out/test-artifacts/witness")], rejected=True)

    def test_hard_linked_output_rejects_before_effects(self):
        fixture = ROOT / "out/test-artifacts" / ("aot-guard-" + uuid.uuid4().hex)
        work = fixture / "work"
        work.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, fixture)
        sentinel = fixture / "protected.props"
        sentinel.write_text("<Project Keep=\"unchanged\" />\n")
        (work / "evidence.json").hardlink_to(sentinel)
        self.invoke(["--work", str(work)], rejected=True)
        self.assertEqual(sentinel.read_text(), "<Project Keep=\"unchanged\" />\n")

    def test_junction_style_descendant_resolution_rejects_before_effects(self):
        fixture = ROOT / "out/test-artifacts" / ("aot-guard-" + uuid.uuid4().hex)
        descendant = fixture / "Producer"
        descendant.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, fixture)
        original_resolve = Path.resolve

        def resolve(path, *args, **kwargs):
            if path == descendant:
                return ROOT / "src"
            return original_resolve(path, *args, **kwargs)

        with patch.object(Path, "resolve", autospec=True, side_effect=resolve):
            self.invoke(["--work", str(fixture)], rejected=True)


if __name__ == "__main__":
    unittest.main()
