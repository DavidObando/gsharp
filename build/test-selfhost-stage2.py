#!/usr/bin/env python3
"""Regression tests for build/selfhost-stage2.py (issue #4631, C3).

The comparison tests hash real assemblies from the Release build with
build/selfhost/PeContentHash.cs, so they need `dotnet` and a built tree;
CI runs them after the solution build.
"""

from __future__ import annotations

import importlib.util
import os
import shlex
import shutil
import struct
import subprocess
import tempfile
import unittest
import zipfile
from unittest.mock import patch
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("selfhost_stage2", REPO / "build" / "selfhost-stage2.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/selfhost-stage2.py")
stage2 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stage2)

CORE = REPO / "out" / "bin" / "Release" / "Core" / "GSharp.Core.dll"
FORMATTING = REPO / "out" / "bin" / "Release" / "GSharp.Formatting" / "GSharp.Formatting.dll"


def work_directory() -> tempfile.TemporaryDirectory:
    parent = REPO / "out" / "obj"
    parent.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(prefix="stage2-test-", dir=parent)


def write_trx(path: Path, executed: int = 1, passed: int = 1, failed: int = 0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        '<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">'
        f'<ResultSummary outcome="Completed"><Counters total="{executed}" executed="{executed}" '
        f'passed="{passed}" failed="{failed}"/></ResultSummary></TestRun>', encoding="utf-8")


def test_results_path(command: list[str], work: Path) -> Path:
    if "--results-directory" in command:
        return Path(command[command.index("--results-directory") + 1]) / "results.trx"
    # The old gate used a fixed logger path; keep the pre-fix witness runnable.
    logger = command[command.index("--logger") + 1]
    return Path(logger.split("LogFileName=", 1)[1])


def mvid_offset(image: bytes) -> int:
    """File offset of the MVID: the first GUID of the #GUID metadata heap."""
    root = image.find(b"BSJB")
    if root < 0:
        raise AssertionError("no metadata root")
    version_length = struct.unpack_from("<I", image, root + 12)[0]
    cursor = root + 16 + version_length + 2
    streams = struct.unpack_from("<H", image, cursor)[0]
    cursor += 2
    for _ in range(streams):
        offset, _size = struct.unpack_from("<II", image, cursor)
        cursor += 8
        end = image.index(b"\0", cursor)
        name = image[cursor:end].decode("ascii")
        cursor = (end + 4) & ~3
        if name == "#GUID":
            return root + offset
    raise AssertionError("no #GUID heap")


def stage(assembly: Path) -> dict:
    return {"assemblies": {"a.dll": str(assembly)}}


class DecideTests(unittest.TestCase):
    def test_no_comparison_is_not_equivalence(self) -> None:
        self.assertEqual((False, True), stage2.decide({"comparison": [], "tests": []}))

    def test_a_failed_test_run_is_reported(self) -> None:
        report = {"comparison": [{"contentEqual": True}], "tests": [
            {"exitCode": 0, "executedTests": 1}, {"exitCode": 1, "executedTests": 1}]}
        self.assertEqual((True, False), stage2.decide(report))

    def test_exit_zero_without_execution_evidence_is_not_a_pass(self) -> None:
        report = {"comparison": [{"contentEqual": True}], "tests": [{"exitCode": 0, "summary": []}]}
        self.assertEqual((True, False), stage2.decide(report))


class RunTests(unittest.TestCase):
    def test_logged_command_preserves_arguments(self) -> None:
        with work_directory() as directory:
            work = Path(directory)
            log = work / "build.log"
            command = ["dotnet", "test", "path with spaces/Test.gsproj", "--filter",
                       "FullyQualifiedName~First|FullyQualifiedName~Second"]
            with patch.object(stage2.subprocess, "run", return_value=subprocess.CompletedProcess(command, 0)) as run:
                code, _ = stage2.run(command, work, {}, log)

            self.assertEqual(0, code)
            self.assertEqual(command, run.call_args.args[0])
            self.assertEqual(command, shlex.split(log.read_text(encoding="utf-8").removeprefix("$ ")))

    def test_requested_runs_need_fresh_positive_passing_evidence(self) -> None:
        for case in ("missing", "stale", "zero", "malformed", "failed", "unpassed"):
            with self.subTest(case=case), work_directory() as directory:
                work = Path(directory)
                cache = work / "nuget-stage2" / "gsharp.net.sdk" / "1.0-stage1" / "gsc.dll"
                cache.parent.mkdir(parents=True)
                cache.write_bytes(b"stage2 compiler")
                if case == "stale":
                    write_trx(work / "test-0" / "results.trx")
                    write_trx(work / "Core.Tests.trx")

                def run(command: list[str], cwd: Path, env: dict, log: Path) -> tuple[int, float]:
                    self.assertEqual(b"stage2 compiler", cache.read_bytes())
                    target = test_results_path(command, work)
                    if case == "zero":
                        write_trx(target, executed=0, passed=0)
                    elif case == "malformed":
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_text("<not-trx", encoding="utf-8")
                    elif case == "failed":
                        write_trx(target, executed=2, passed=1, failed=1)
                    elif case == "unpassed":
                        write_trx(target, executed=2, passed=1)
                    return 0, 0.0

                with patch.object(stage2, "run", side_effect=run):
                    results = stage2.run_tests(work, ["test/Core.Tests.gsproj::NoMatch"], work, "Release")
                self.assertEqual(1, len(results))
                self.assertFalse(stage2.decide({"comparison": [{"contentEqual": True}], "tests": results})[1],
                                 f"exit-zero {case} test evidence must fail the gate")

    def test_same_stem_and_multiple_frameworks_have_independent_evidence(self) -> None:
        with work_directory() as directory:
            work = Path(directory)
            result_paths = []

            def run(command: list[str], cwd: Path, env: dict, log: Path) -> tuple[int, float]:
                target = test_results_path(command, work)
                result_paths.append(target)
                write_trx(target, executed=2, passed=2)
                write_trx(target.with_name("second-framework.trx"), executed=3, passed=3)
                return 0, 0.0

            with patch.object(stage2, "run", side_effect=run):
                results = stage2.run_tests(work, ["a/Tests.gsproj::One", "b/Tests.gsproj::Two"],
                                           work, "Release")
            self.assertEqual(2, len(results))
            self.assertNotEqual(result_paths[0], result_paths[1])
            self.assertEqual([5, 5], [row.get("executedTests") for row in results])
            self.assertTrue(stage2.decide({"comparison": [{"contentEqual": True}], "tests": results})[1])


class MainTests(unittest.TestCase):
    @staticmethod
    def package(work: Path, version: str, source: str) -> Path:
        package = work / f"Gsharp.NET.Sdk.{version}.nupkg"
        with zipfile.ZipFile(package, "w") as archive:
            archive.writestr("Sdk/Sdk.props", "<Project/>")
            for stem in stage2.packer.GSHARP_COMPILED:
                archive.writestr(stem + ".dll", b"fixture assembly")
                archive.writestr(stem + ".pdb", f"source.{source}".encode())
        return package

    def invoke(self, work: Path, bootstrap: Path, stage1: Path, extra: list[str]):
        row = {"assembly": "a.dll", "stage1": {"content": "A"}, "stage2": {"content": "A"},
               "contentEqual": True, "bytesEqual": True}
        with patch.object(stage2, "build_stage", return_value=stage(work / "a.dll")) as build, \
                patch.object(stage2, "compare", return_value=[row]), \
                patch.object(stage2, "run_tests", return_value=[]), \
                patch.object(stage2.packer, "verify", wraps=stage2.packer.verify) as verify:
            code = stage2.main(["--tree", str(work), "--work", str(work / "gate"),
                                "--bootstrap", str(bootstrap), "--stage1", str(stage1), *extra])
        return code, build, verify

    def test_identical_bootstrap_and_stage1_cannot_build(self) -> None:
        with work_directory() as directory:
            work = Path(directory)
            bootstrap = self.package(work, "1.0.0", "cs")
            code, build, _ = self.invoke(work, bootstrap, bootstrap, [])
            self.assertEqual(2, code)
            build.assert_not_called()

    def test_distinct_stage1_package_must_have_gsharp_provenance(self) -> None:
        with work_directory() as directory:
            work = Path(directory)
            bootstrap = self.package(work, "1.0.0", "cs")
            stage1 = self.package(work, "1.0.0-stage1", "cs")
            code, build, verify = self.invoke(work, bootstrap, stage1, [])
            self.assertEqual(2, code)
            verify.assert_called_once_with(stage1, bootstrap)
            build.assert_not_called()

    def test_verified_package_and_configuration_derived_output(self) -> None:
        for config, extra, output in [
            ("Release", [], "out/bin/Release/Core/GSharp.Core.dll"),
            ("Debug", [], "out/bin/Debug/Core/GSharp.Core.dll"),
            ("Debug", ["--assembly", "custom/Core.dll"], "custom/Core.dll"),
        ]:
            with self.subTest(config=config, output=output), work_directory() as directory:
                work = Path(directory)
                bootstrap = self.package(work, "1.0.0", "cs")
                stage1 = self.package(work, "1.0.0-stage1", "gs")
                code, build, verify = self.invoke(work, bootstrap, stage1, ["--config", config, *extra])
                self.assertEqual(0, code)
                verify.assert_called_once_with(stage1, bootstrap)
                self.assertEqual(2, build.call_count)
                for call in build.call_args_list:
                    self.assertEqual([output], call.args[4])
                    self.assertEqual(config, call.args[6])


class CleanOutputsTests(unittest.TestCase):
    def test_configured_outputs_are_clean_before_rebuild(self) -> None:
        with work_directory() as directory:
            tree = Path(directory)
            work = tree / "work"
            work.mkdir()
            assembly = tree / "custom" / "Core.dll"
            assembly.parent.mkdir()
            assembly.write_bytes(b"stale assembly")
            assembly.with_suffix(".pdb").write_bytes(b"stale symbols")
            (tree / "out").mkdir()
            (tree / "out" / "stale.bin").write_bytes(b"stale output")

            def rebuild(command: list[str], cwd: Path, env: dict, log: Path) -> tuple[int, float]:
                self.assertEqual(["dotnet", "build", "src/Core.gsproj", "-c", "Release",
                                  "-t:Rebuild", "-nodeReuse:false"], command)
                self.assertFalse(assembly.exists())
                self.assertFalse(assembly.with_suffix(".pdb").exists())
                self.assertFalse((tree / "out").exists())
                assembly.write_bytes(b"rebuilt assembly")
                return 0, 0.0

            with patch.object(stage2, "pin", return_value="10.0"), \
                    patch.object(stage2, "run", side_effect=rebuild):
                result = stage2.build_stage(tree, "stage1", Path("unused.nupkg"), ["src/Core.gsproj"],
                                            ["custom/Core.dll"], work, "Release")

            self.assertEqual(b"rebuilt assembly", Path(result["assemblies"]["custom/Core.dll"]).read_bytes())

    def test_reused_work_clears_only_the_building_stage_package_cache(self) -> None:
        for current, other in (("stage1", "stage2"), ("stage2", "stage1")):
            with self.subTest(stage=current), work_directory() as directory:
                tree = Path(directory)
                work = tree / "work"
                work.mkdir()
                cached = {}
                for name in (current, other):
                    path = work / f"nuget-{name}" / "gsharp.net.sdk" / "1.0-stage1" / "tools/compiler/gsc.dll"
                    path.parent.mkdir(parents=True)
                    path.write_bytes(b"old same-version compiler")
                    cached[name] = path

                def rebuild(command: list[str], cwd: Path, env: dict, log: Path) -> tuple[int, float]:
                    self.assertEqual(str(work / f"nuget-{current}"), env["NUGET_PACKAGES"])
                    self.assertFalse(cached[current].exists(), "stale extracted SDK survived build_stage")
                    self.assertTrue(cached[other].exists(), "cleared the other stage's cache")
                    (tree / "a.dll").write_bytes(b"rebuilt")
                    return 0, 0.0

                with patch.object(stage2, "pin", return_value="1.0-stage1"), \
                        patch.object(stage2, "run", side_effect=rebuild):
                    stage2.build_stage(tree, current, Path("unused.nupkg"), ["a.gsproj"],
                                       ["a.dll"], work, "Release")


HAVE_BUILD = CORE.exists() and FORMATTING.exists() and shutil.which("dotnet") is not None
if os.environ.get("CI") and not HAVE_BUILD:
    # In CI these run after the Release build; a skip there would be vacuous.
    raise RuntimeError("CI run without a Release build: build GSharp.sln before this script")


@unittest.skipUnless(HAVE_BUILD, "needs a Release build and dotnet")
class CompareTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = work_directory()
        self.work = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_the_same_assembly_is_equal(self) -> None:
        copy = self.work / "copy with  two spaces.dll"
        shutil.copy2(CORE, copy)
        row = stage2.compare(stage(CORE), stage(copy), self.work)[0]
        self.assertTrue(row["contentEqual"])
        self.assertTrue(row["bytesEqual"])
        self.assertGreater(row["stage1"]["methods"], 1000)

    def test_a_different_assembly_is_not_equal(self) -> None:
        # The deliberately broken input: stage 2 produced different code.
        row = stage2.compare(stage(CORE), stage(FORMATTING), self.work)[0]
        self.assertFalse(row["contentEqual"])
        self.assertFalse(stage2.decide({"comparison": [row], "tests": []})[0])

    def test_a_one_byte_il_change_is_not_equal(self) -> None:
        offset = subprocess.run(
            ["dotnet", "run", str(stage2.HASH_TOOL), "--", "--il-offset", str(CORE)],
            cwd=stage2.HASH_TOOL.parent, capture_output=True, text=True, check=True).stdout.strip()
        image = bytearray(CORE.read_bytes())
        image[int(offset)] ^= 0x01
        patched = self.work / "il.dll"
        patched.write_bytes(bytes(image))
        row = stage2.compare(stage(CORE), stage(patched), self.work)[0]
        self.assertFalse(row["contentEqual"], "IL bytes must be part of the hash")

    def test_only_the_mvid_differing_is_equal_content(self) -> None:
        image = bytearray(CORE.read_bytes())
        at = mvid_offset(bytes(image))
        image[at:at + 16] = bytes(255 - b for b in image[at:at + 16])
        patched = self.work / "patched.dll"
        patched.write_bytes(bytes(image))
        row = stage2.compare(stage(CORE), stage(patched), self.work)[0]
        self.assertFalse(row["bytesEqual"])
        self.assertTrue(row["contentEqual"], "the MVID must be zeroed before hashing")

    def test_method_header_only_change_is_not_equivalent(self) -> None:
        self.check_body_mutant("header-only.dll")

    def test_catch_type_only_change_is_not_equivalent(self) -> None:
        self.check_body_mutant("eh-only.dll")

    def check_body_mutant(self, name: str) -> None:
        mutation = subprocess.run(
            ["dotnet", "run", str(REPO / "build/selfhost/PeBodyMutations.cs"), "--",
             str(CORE), str(self.work)], cwd=stage2.HASH_TOOL.parent,
            env=stage2.stage_env(self.work, "mutations"), capture_output=True, text=True, check=True)
        row = stage2.compare(stage(CORE), stage(self.work / name), self.work)[0]
        self.assertFalse(row["bytesEqual"])
        self.assertFalse(row["contentEqual"], mutation.stdout)
        self.assertFalse(stage2.decide({"comparison": [row], "tests": []})[0])


if __name__ == "__main__":
    unittest.main()
