#!/usr/bin/env python3
"""ADR-0154 regression tests for the ADR-0198 stage-2 controller."""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import struct
import subprocess
import sys
import unittest
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DRIVER = REPO / "build" / "selfhost-stage2.py"
ARTIFACTS = REPO / "build" / ".stage2-test-artifacts"
_PE_SPEC = importlib.util.spec_from_file_location("selfhost_pe", REPO / "build" / "selfhost_pe.py")
if _PE_SPEC is None or _PE_SPEC.loader is None:
    raise RuntimeError("cannot load build/selfhost_pe.py")
pe = importlib.util.module_from_spec(_PE_SPEC)
sys.modules[_PE_SPEC.name] = pe
_PE_SPEC.loader.exec_module(pe)


def run_driver(*arguments: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(DRIVER), *(str(argument) for argument in arguments)],
        cwd=REPO, text=True, capture_output=True)


def mutate(source: Path, destination: Path, offset: int, value: int | None = None) -> None:
    data = bytearray(source.read_bytes())
    data[offset] = value if value is not None else data[offset] ^ 1
    destination.write_bytes(data)


def remove_tree(path: Path) -> None:
    if path.exists():
        for child in path.rglob("*"):
            try:
                os.chmod(child, 0o700 if child.is_dir() else 0o600)
            except FileNotFoundError:
                pass
        os.chmod(path, 0o700)
        shutil.rmtree(path)


class PeComparisonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        remove_tree(ARTIFACTS)
        project = ARTIFACTS / "fixture"
        project.mkdir(parents=True)
        (project / "Fixture.csproj").write_text(
            """<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <Optimize>true</Optimize>
    <Deterministic>true</Deterministic>
  </PropertyGroup>
  <ItemGroup>
    <EmbeddedResource Include="payload.bin" />
  </ItemGroup>
</Project>
""", encoding="utf-8")
        (project / "Program.cs").write_text(
            """using System;

[assembly: Bytes(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16)]

[AttributeUsage(AttributeTargets.Assembly)]
sealed class BytesAttribute(params byte[] value) : Attribute;

static class Program
{
    static int Fat(int value)
    {
        try
        {
            if (value == 0) throw new InvalidOperationException();
            return value + 0x123456;
        }
        catch (InvalidOperationException)
        {
            return -1;
        }
        catch (SystemException)
        {
            return -2;
        }
    }

    static int Main() => Fat(1);
}
""", encoding="utf-8")
        (project / "payload.bin").write_bytes(b"ADR0198-MANAGED-RESOURCE-MARKER")
        result = subprocess.run(
            ["dotnet", "build", "Fixture.csproj", "-c", "Release", "--nologo",
             "-p:ImportDirectoryBuildProps=false",
             "-p:ImportDirectoryBuildTargets=false",
             "-p:TreatWarningsAsErrors=false"],
            cwd=project, text=True, capture_output=True)
        if result.returncode != 0:
            raise RuntimeError(result.stdout + result.stderr)
        cls.fixture = project / "bin" / "Release" / "net10.0" / "Fixture.dll"
        cls.mutants = ARTIFACTS / "mutants"
        cls.mutants.mkdir()
        helper = subprocess.run(
            ["dotnet", "run", str(REPO / "build" / "selfhost" / "PeBodyMutations.cs"),
             "--", str(cls.fixture), str(cls.mutants)],
            cwd=REPO, text=True, capture_output=True)
        if helper.returncode != 0:
            raise RuntimeError(helper.stdout + helper.stderr)
        helper = subprocess.run(
            ["dotnet", "run", str(REPO / "build" / "selfhost" / "PeBodyMutations.cs"),
             "--", str(cls.fixture), str(cls.mutants), "--runtime-header"],
            cwd=REPO, text=True, capture_output=True)
        if helper.returncode != 0:
            raise RuntimeError(helper.stdout + helper.stderr)

    @classmethod
    def tearDownClass(cls) -> None:
        remove_tree(ARTIFACTS)

    def assert_different(self, mutant: Path) -> None:
        result = run_driver("--compare-pe", self.fixture, mutant)
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertFalse(json.loads(result.stdout)["normalizedEqual"])

    def test_same_complete_pe_is_equal(self) -> None:
        result = run_driver("--compare-pe", self.fixture, self.fixture)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertTrue(json.loads(result.stdout)["normalizedEqual"])

    def test_only_structural_mvid_slot_is_ignored(self) -> None:
        mutant = self.mutants / "mvid-only.dll"
        layout = pe.inspect_layout(self.fixture.read_bytes())
        mutate(self.fixture, mutant, layout.mvid_offset)
        result = run_driver("--compare-pe", self.fixture, mutant)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(report["normalizedEqual"])
        self.assertFalse(report["rawEqual"])

    def test_repeated_mvid_bytes_in_attribute_are_not_ignored(self) -> None:
        marker = bytes(range(1, 17))
        base = bytearray(self.fixture.read_bytes())
        marker_offset = base.find(marker)
        self.assertGreater(marker_offset, 0)
        layout = pe.inspect_layout(base)
        base[marker_offset:marker_offset + 16] = base[layout.mvid_offset:layout.mvid_offset + 16]
        left = self.mutants / "attribute-mvid-left.dll"
        right = self.mutants / "attribute-mvid-right.dll"
        left.write_bytes(base)
        base[marker_offset] ^= 1
        right.write_bytes(base)
        self.assert_different(right)
        result = run_driver("--compare-pe", left, right)
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)

    def test_coff_machine_mutation_is_rejected(self) -> None:
        data = self.fixture.read_bytes()
        pe_offset = struct.unpack_from("<I", data, 0x3C)[0]
        mutant = self.mutants / "machine.dll"
        mutate(self.fixture, mutant, pe_offset + 4)
        self.assert_different(mutant)

    def test_managed_resource_mutation_is_rejected(self) -> None:
        data = self.fixture.read_bytes()
        offset = data.find(b"ADR0198-MANAGED-RESOURCE-MARKER")
        self.assertGreater(offset, 0)
        mutant = self.mutants / "resource.dll"
        mutate(self.fixture, mutant, offset)
        self.assert_different(mutant)

    def test_non_mvid_metadata_mutation_is_rejected(self) -> None:
        data = self.fixture.read_bytes()
        offset = data.find(b"Fixture")
        self.assertGreater(offset, 0)
        mutant = self.mutants / "metadata.dll"
        mutate(self.fixture, mutant, offset)
        self.assert_different(mutant)

    def test_method_header_mutation_is_rejected(self) -> None:
        self.assert_different(self.mutants / "header-only.dll")

    def test_exception_region_mutation_is_rejected(self) -> None:
        self.assert_different(self.mutants / "eh-only.dll")

    def test_clr_entrypoint_mutation_is_rejected(self) -> None:
        self.assert_different(self.mutants / "entrypoint-only.dll")

    def test_clr_flags_mutation_is_rejected(self) -> None:
        self.assert_different(self.mutants / "flags-only.dll")

    def test_zero_mvid_index_is_rejected(self) -> None:
        data = bytearray(self.fixture.read_bytes())
        layout = pe.inspect_layout(data)
        data[layout.mvid_index_offset:layout.mvid_index_offset + layout.guid_index_size] = \
            bytes(layout.guid_index_size)
        mutant = self.mutants / "zero-mvid.dll"
        mutant.write_bytes(data)
        result = run_driver("--compare-pe", self.fixture, mutant)
        self.assertEqual(2, result.returncode)
        self.assertIn("zero GUID index", result.stderr)

    def test_out_of_range_mvid_index_is_rejected(self) -> None:
        data = bytearray(self.fixture.read_bytes())
        layout = pe.inspect_layout(data)
        invalid = layout.guid_stream_size // 16 + 2
        data[layout.mvid_index_offset:layout.mvid_index_offset + layout.guid_index_size] = \
            invalid.to_bytes(layout.guid_index_size, "little")
        mutant = self.mutants / "range-mvid.dll"
        mutant.write_bytes(data)
        result = run_driver("--compare-pe", self.fixture, mutant)
        self.assertEqual(2, result.returncode)
        self.assertIn("outside the #GUID stream", result.stderr)

    def test_truncated_metadata_is_rejected(self) -> None:
        mutant = self.mutants / "truncated.dll"
        mutant.write_bytes(self.fixture.read_bytes()[:-32])
        result = run_driver("--compare-pe", self.fixture, mutant)
        self.assertEqual(2, result.returncode)


class ControllerBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        suffix = self.id().rsplit(".", 1)[-1]
        self.root = REPO / "build" / f".stage2-controller-test-{suffix}"
        remove_tree(self.root)
        self.root.mkdir()
        self.package = self.root / "Gsharp.NET.Sdk.1.2.3.nupkg"
        with zipfile.ZipFile(self.package, "w") as archive:
            archive.writestr("Gsharp.NET.Sdk.nuspec", "<package><metadata><id>Gsharp.NET.Sdk</id>"
                             "<version>1.2.3</version></metadata></package>")

    def tearDown(self) -> None:
        remove_tree(self.root)

    def tree(self) -> Path:
        tree = self.root / "tree"
        tree.mkdir()
        (tree / "global.json").write_text(
            '{"msbuild-sdks":{"Gsharp.NET.Sdk":"1.2.3"}}\n', encoding="utf-8")
        return tree

    def test_workspace_containing_source_is_rejected_without_mutation(self) -> None:
        tree = self.tree()
        original = (tree / "global.json").read_bytes()
        result = run_driver(
            "--tree", tree, "--bootstrap", self.package, "--work", self.root)
        self.assertEqual(2, result.returncode)
        self.assertEqual(original, (tree / "global.json").read_bytes())

    def test_source_containing_workspace_is_rejected_without_mutation(self) -> None:
        tree = self.tree()
        original = (tree / "global.json").read_bytes()
        result = run_driver(
            "--tree", tree, "--bootstrap", self.package, "--work", tree / "work")
        self.assertEqual(2, result.returncode)
        self.assertEqual(original, (tree / "global.json").read_bytes())

    @unittest.skipIf(not hasattr(os, "symlink"), "symlinks unsupported")
    def test_aliased_global_json_is_rejected_without_mutation(self) -> None:
        tree = self.tree()
        target = tree / "other.json"
        target.write_bytes((tree / "global.json").read_bytes())
        (tree / "global.json").unlink()
        (tree / "global.json").symlink_to(target.name)
        result = run_driver(
            "--tree", tree, "--bootstrap", self.package,
            "--work", self.root / "work")
        self.assertEqual(2, result.returncode)
        self.assertEqual(
            b'{"msbuild-sdks":{"Gsharp.NET.Sdk":"1.2.3"}}\n',
            target.read_bytes())

    def test_hardlinked_input_is_rejected_without_mutation(self) -> None:
        tree = self.tree()
        target = tree / "other.json"
        os.link(tree / "global.json", target)
        original = target.read_bytes()
        result = run_driver(
            "--tree", tree, "--bootstrap", self.package,
            "--work", self.root / "work")
        self.assertEqual(2, result.returncode)
        self.assertEqual(original, target.read_bytes())

    def test_existing_report_root_is_never_overwritten(self) -> None:
        tree = self.tree()
        work = self.root / "work"
        work.mkdir()
        sentinel = work / "stage2-report.json"
        sentinel.write_text("project input", encoding="utf-8")
        result = run_driver(
            "--tree", tree, "--bootstrap", self.package, "--work", work)
        self.assertEqual(2, result.returncode)
        self.assertEqual("project input", sentinel.read_text(encoding="utf-8"))

    def test_secret_restore_configuration_is_redacted_and_rejected(self) -> None:
        tree = self.tree()
        secret = "NEVER-PRINT-ADR0198-SECRET"
        (tree / "NuGet.Config").write_text(
            f"<configuration><packageSourceCredentials><x><Password value=\"{secret}\" />"
            "</x></packageSourceCredentials></configuration>", encoding="utf-8")
        work = self.root / "work"
        result = run_driver(
            "--tree", tree, "--bootstrap", self.package, "--work", work)
        self.assertEqual(2, result.returncode)
        evidence = "".join(
            path.read_text(encoding="utf-8", errors="replace")
            for root in ("evidence", "logs", "reports")
            for path in (work / root).rglob("*") if path.is_file())
        self.assertNotIn(secret, result.stdout + result.stderr + evidence)

    def test_versioned_project_sdk_override_is_rejected_by_real_driver(self) -> None:
        tree = self.tree()
        project = tree / "App.gsproj"
        project.write_text(
            '<Project Sdk="Gsharp.NET.Sdk/1.2.3"></Project>', encoding="utf-8")
        result = run_driver("--validate-project", tree, project)
        self.assertEqual(2, result.returncode)
        self.assertIn("overrides the global SDK pin", result.stderr)

    def test_project_controlled_target_cannot_forge_receipts(self) -> None:
        tree = self.tree()
        project = tree / "App.gsproj"
        project.write_text(
            '<Project Sdk="Gsharp.NET.Sdk"><Target Name="ForgeReceipt" /></Project>',
            encoding="utf-8")
        result = run_driver("--validate-project", tree, project)
        self.assertEqual(2, result.returncode)
        self.assertIn("unmodeled project target", result.stderr)

    def test_build_project_references_local_override_is_rejected(self) -> None:
        tree = self.tree()
        project = tree / "App.gsproj"
        project.write_text(
            '<Project Sdk="Gsharp.NET.Sdk" TreatAsLocalProperty="BuildProjectReferences" />',
            encoding="utf-8")
        result = run_driver("--validate-project", tree, project)
        self.assertEqual(2, result.returncode)
        self.assertIn("protected properties", result.stderr)


if __name__ == "__main__":
    unittest.main()
