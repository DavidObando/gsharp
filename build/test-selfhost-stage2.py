#!/usr/bin/env python3
"""ADR-0154 regression tests for the ADR-0198 stage-2 controller."""

from __future__ import annotations

import importlib.util
import base64
import hashlib
import hmac
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

    def test_truncated_guid_stream_is_rejected(self) -> None:
        data = bytearray(self.fixture.read_bytes())
        layout = pe.inspect_layout(data)
        name = data.find(b"#GUID\0")
        self.assertGreater(name, 4)
        struct.pack_into("<I", data, name - 4, layout.guid_stream_size - 1)
        mutant = self.mutants / "truncated-guid.dll"
        mutant.write_bytes(data)
        result = run_driver("--compare-pe", self.fixture, mutant)
        self.assertEqual(2, result.returncode)
        self.assertIn("truncated #GUID stream", result.stderr)

    def test_truncated_metadata_is_rejected(self) -> None:
        mutant = self.mutants / "truncated.dll"
        mutant.write_bytes(self.fixture.read_bytes()[:-32])
        result = run_driver("--compare-pe", self.fixture, mutant)
        self.assertEqual(2, result.returncode)

    def test_stream_overlapping_metadata_headers_is_rejected(self) -> None:
        data = bytearray(self.fixture.read_bytes())
        name = data.find(b"#GUID\0")
        self.assertGreater(name, 8)
        struct.pack_into("<I", data, name - 8, 0)
        mutant = self.mutants / "guid-in-headers.dll"
        mutant.write_bytes(data)
        result = run_driver("--compare-pe", self.fixture, mutant)
        self.assertEqual(2, result.returncode)
        self.assertIn("overlaps", result.stderr)


class ControllerBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        suffix = self.id().rsplit(".", 1)[-1]
        self.root = REPO / "build" / f".stage2-controller-test-{suffix}"
        remove_tree(self.root)
        self.root.mkdir()
        self.package = self.root / "Gsharp.NET.Sdk.0.4.591.nupkg"
        with zipfile.ZipFile(self.package, "w") as archive:
            archive.writestr("Gsharp.NET.Sdk.nuspec", "<package><metadata><id>Gsharp.NET.Sdk</id>"
                             "<version>0.4.591</version></metadata></package>")

    def tearDown(self) -> None:
        remove_tree(self.root)

    def tree(self) -> Path:
        tree = self.root / "tree"
        tree.mkdir()
        (tree / "global.json").write_text(
            '{"msbuild-sdks":{"Gsharp.NET.Sdk":"0.4.591"}}\n', encoding="utf-8")
        return tree

    @staticmethod
    def commit_tree(tree: Path) -> None:
        subprocess.run(["git", "init", "-b", "main", tree], check=True, capture_output=True)
        subprocess.run(
            ["git", "-C", tree, "config", "user.email", "adr0198@example.invalid"],
            check=True)
        subprocess.run(
            ["git", "-C", tree, "config", "user.name", "ADR 0198 Test"],
            check=True)
        subprocess.run(["git", "-C", tree, "add", "."], check=True)
        subprocess.run(
            ["git", "-C", tree, "commit", "-m", "fixture"],
            check=True, capture_output=True)

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
        self.commit_tree(tree)
        result = run_driver(
            "--tree", tree, "--bootstrap", self.package,
            "--work", self.root / "work", "--test", "Tests.gsproj::Smoke")
        self.assertEqual(2, result.returncode)
        self.assertEqual(
            b'{"msbuild-sdks":{"Gsharp.NET.Sdk":"0.4.591"}}\n',
            target.read_bytes())

    def test_hardlinked_input_is_rejected_without_mutation(self) -> None:
        tree = self.tree()
        target = tree / "other.json"
        os.link(tree / "global.json", target)
        original = target.read_bytes()
        self.commit_tree(tree)
        result = run_driver(
            "--tree", tree, "--bootstrap", self.package,
            "--work", self.root / "work", "--test", "Tests.gsproj::Smoke")
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
        self.commit_tree(tree)
        work = self.root / "work"
        result = run_driver(
            "--tree", tree, "--bootstrap", self.package, "--work", work,
            "--test", "Tests.gsproj::Smoke")
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
            '<Project Sdk="Gsharp.NET.Sdk/0.4.591"></Project>', encoding="utf-8")
        result = run_driver("--validate-project", tree, project)
        self.assertEqual(2, result.returncode)
        self.assertIn("overrides the global SDK pin", result.stderr)

    def test_versioned_sdk_element_and_import_are_rejected(self) -> None:
        for declaration in (
            '<Sdk Name="Gsharp.NET.Sdk" Version="0.4.591" />',
            '<Import Project="Sdk.props" Sdk="Gsharp.NET.Sdk/0.4.591" />',
        ):
            with self.subTest(declaration=declaration):
                tree = self.tree()
                project = tree / "App.gsproj"
                project.write_text(
                    f"<Project>{declaration}</Project>", encoding="utf-8")
                result = run_driver("--validate-project", tree, project)
                self.assertEqual(2, result.returncode)
                self.assertIn("overrides the global SDK pin", result.stderr)
                remove_tree(tree)

    def test_external_import_custom_definitions_are_rejected(self) -> None:
        tree = self.tree()
        imported = tree / "package.targets"
        imported.write_text(
            '<Project><UsingTask TaskName="Example.Task" AssemblyFile="task.dll" />'
            '<Target Name="ExampleTarget" /></Project>',
            encoding="utf-8")
        result = run_driver("--validate-import", tree, imported)
        self.assertEqual(2, result.returncode)
        self.assertIn("external custom targets and tasks", result.stderr)

    def test_project_controlled_target_cannot_forge_receipts(self) -> None:
        tree = self.tree()
        project = tree / "App.gsproj"
        project.write_text(
            '<Project Sdk="Gsharp.NET.Sdk"><Target Name="ForgeReceipt" /></Project>',
            encoding="utf-8")
        result = run_driver("--validate-project", tree, project)
        self.assertEqual(2, result.returncode)
        self.assertIn("unmodeled project target definition", result.stderr)

    def test_named_allowed_target_with_changed_definition_is_rejected(self) -> None:
        tree = self.tree()
        project = (
            tree / "src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj")
        project.parent.mkdir(parents=True)
        project.write_text(
            '<Project Sdk="Gsharp.NET.Sdk">'
            '<Target Name="PackGsharpCompiler" BeforeTargets="Build">'
            '<Exec Command="forged" /></Target></Project>',
            encoding="utf-8")
        result = run_driver("--validate-project", tree, project)
        self.assertEqual(2, result.returncode)
        self.assertIn("unmodeled project target definition", result.stderr)

    def test_build_project_references_local_override_is_rejected(self) -> None:
        tree = self.tree()
        project = tree / "App.gsproj"
        project.write_text(
            '<Project Sdk="Gsharp.NET.Sdk" TreatAsLocalProperty="BuildProjectReferences" />',
            encoding="utf-8")
        result = run_driver("--validate-project", tree, project)
        self.assertEqual(2, result.returncode)
        self.assertIn("protected properties", result.stderr)

    def test_stage1_version_path_escape_is_rejected(self) -> None:
        tree = self.tree()
        result = run_driver(
            "--tree", tree, "--bootstrap", self.package,
            "--work", self.root / "work", "--stage1-version", "../escape")
        self.assertEqual(2, result.returncode)
        self.assertIn("not a valid package version", result.stderr)

    def test_package_path_components_cannot_escape_controller_roots(self) -> None:
        for value in ("../victim", "a/b", r"a\b", ".", "..", "/rooted"):
            with self.subTest(value=value):
                result = run_driver("--validate-package-component", value)
                self.assertEqual(2, result.returncode)
                self.assertIn("unsafe package component", result.stderr)

    def test_non_git_source_tree_is_rejected(self) -> None:
        tree = self.tree()
        result = run_driver(
            "--tree", tree, "--bootstrap", self.package,
            "--work", self.root / "work", "--test", "Tests.gsproj::Smoke")
        self.assertEqual(2, result.returncode)
        self.assertIn("root of a clean Git worktree", result.stderr)

    def test_positive_test_selection_is_required(self) -> None:
        tree = self.tree()
        result = run_driver(
            "--tree", tree, "--bootstrap", self.package,
            "--work", self.root / "work")
        self.assertEqual(2, result.returncode)
        self.assertIn("at least one --test", result.stderr)

    def test_snapshot_bytes_come_from_the_recorded_commit(self) -> None:
        tree = self.tree()
        subprocess.run(["git", "init", "-b", "main", tree], check=True, capture_output=True)
        subprocess.run(
            ["git", "-C", tree, "config", "user.email", "adr0198@example.invalid"],
            check=True)
        subprocess.run(
            ["git", "-C", tree, "config", "user.name", "ADR 0198 Test"],
            check=True)
        subprocess.run(
            ["git", "-C", tree, "config", "filter.adr0198.clean",
             "sed s/WORKTREE/COMMIT/g"], check=True)
        subprocess.run(
            ["git", "-C", tree, "config", "filter.adr0198.smudge",
             "sed s/COMMIT/WORKTREE/g"], check=True)
        (tree / ".gitattributes").write_text(
            "payload.txt filter=adr0198\n", encoding="utf-8")
        (tree / "payload.txt").write_text("WORKTREE\n", encoding="utf-8")
        subprocess.run(["git", "-C", tree, "add", "."], check=True)
        subprocess.run(
            ["git", "-C", tree, "commit", "-m", "filtered fixture"],
            check=True, capture_output=True)
        self.assertEqual(
            b"COMMIT\n",
            subprocess.run(
                ["git", "-C", tree, "show", "HEAD:payload.txt"],
                check=True, capture_output=True).stdout)
        self.assertEqual(b"WORKTREE\n", (tree / "payload.txt").read_bytes())
        snapshot = self.root / "snapshot"
        result = run_driver("--freeze-source", tree, snapshot)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual(b"COMMIT\n", (snapshot / "payload.txt").read_bytes())

    def test_stage1_version_must_differ_from_bootstrap(self) -> None:
        tree = self.tree()
        result = run_driver(
            "--tree", tree, "--bootstrap", self.package,
            "--work", self.root / "work", "--stage1-version", "0.4.591")
        self.assertEqual(2, result.returncode)
        self.assertIn("must differ", result.stderr)

    def test_absolute_assembly_path_is_rejected(self) -> None:
        tree = self.tree()
        result = run_driver(
            "--tree", tree, "--bootstrap", self.package,
            "--work", self.root / "work", "--assembly", self.package)
        self.assertEqual(2, result.returncode)
        self.assertIn("relative to the stage output root", result.stderr)

    def test_symbolic_link_root_is_rejected_before_resolution(self) -> None:
        tree = self.tree()
        alias = self.root / "tree-alias"
        alias.symlink_to(tree, target_is_directory=True)
        result = run_driver(
            "--tree", alias, "--bootstrap", self.package,
            "--work", self.root / "work")
        self.assertEqual(2, result.returncode)
        self.assertIn("symbolic-link path", result.stderr)

    def test_repeated_roots_and_tests_are_rejected(self) -> None:
        for arguments in (
            ("--project", "App.gsproj", "--project", "App.gsproj"),
            ("--test", "Tests.gsproj::A", "--test", "Tests.gsproj::A"),
        ):
            with self.subTest(arguments=arguments):
                tree = self.tree()
                result = run_driver(
                    "--tree", tree, "--bootstrap", self.package,
                    "--work", self.root / "work", *arguments)
                self.assertEqual(2, result.returncode)
                self.assertIn("repeated --", result.stderr)
                remove_tree(tree)
                remove_tree(self.root / "work")

    def test_sandbox_hides_secrets_caller_siblings_controller_and_network(self) -> None:
        tree = self.tree()
        writable = self.root / "allowed"
        caller = self.root / "caller-tree" / "secret"
        sibling = self.root / "sibling-stage" / "secret"
        evidence = self.root / "evidence" / "receipt"
        caller.parent.mkdir()
        sibling.parent.mkdir()
        evidence.parent.mkdir()
        caller.write_text("caller", encoding="utf-8")
        sibling.write_text("secret", encoding="utf-8")
        evidence.write_text("evidence", encoding="utf-8")
        result = run_driver(
            "--sandbox-probe", tree, writable, caller, sibling, evidence)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertTrue((writable / "allowed-write").is_file())
        self.assertFalse((tree / "forbidden-write").exists())


class ReceiptBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        suffix = self.id().rsplit(".", 1)[-1]
        self.root = REPO / "build" / f".stage2-receipt-test-{suffix}"
        remove_tree(self.root)
        self.root.mkdir()
        self.run_id = "run-adr0198"

    def tearDown(self) -> None:
        remove_tree(self.root)

    def receipt(self, name: str, nonce: str) -> Path:
        log = self.root / f"{name}.log"
        output = self.root / f"{name}.dll"
        events = self.root / f"{name}.events"
        log.write_text("log", encoding="utf-8")
        output.write_bytes(b"output")
        events.write_text("events", encoding="utf-8")
        receipt = self.root / f"{name}.json"
        receipt.write_text(json.dumps({
            "runId": self.run_id,
            "nonceCommitment": nonce,
            "stage": "stage-2",
            "purpose": "test",
            "pid": 123,
            "arguments": ["dotnet", "test"],
            "sandboxArgumentsSha256": "b" * 64,
            "graphIdentity": "c" * 64,
            "startedNs": 1,
            "completedNs": 2,
            "exitCode": 0,
            "stdout": {
                "path": str(log),
                "sha256": hashlib.sha256(log.read_bytes()).hexdigest(),
            },
            "outputs": [{
                "path": str(output),
                "size": output.stat().st_size,
                "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
            }],
            "events": {
                "path": str(events),
                "sha256": hashlib.sha256(events.read_bytes()).hexdigest(),
            },
        }), encoding="utf-8")
        return receipt

    def test_fresh_receipt_is_accepted(self) -> None:
        receipt = self.receipt("one", "1" * 64)
        result = run_driver("--verify-receipts", self.run_id, receipt)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_replayed_receipt_and_nonce_are_rejected(self) -> None:
        first = self.receipt("one", "1" * 64)
        second = self.receipt("two", "1" * 64)
        for receipts in ((first, first), (first, second)):
            with self.subTest(receipts=receipts):
                result = run_driver(
                    "--verify-receipts", self.run_id, *receipts)
                self.assertEqual(2, result.returncode)
                self.assertIn("replayed", result.stderr)

    def test_stale_or_mismatched_receipt_is_rejected(self) -> None:
        receipt = self.receipt("one", "1" * 64)
        result = run_driver("--verify-receipts", "other-run", receipt)
        self.assertEqual(2, result.returncode)
        self.assertIn("stale", result.stderr)

    def test_output_log_and_event_replacement_are_rejected(self) -> None:
        for suffix in (".dll", ".log", ".events"):
            with self.subTest(suffix=suffix):
                receipt = self.receipt("one", "1" * 64)
                (self.root / f"one{suffix}").write_text("replaced", encoding="utf-8")
                result = run_driver(
                    "--verify-receipts", self.run_id, receipt)
                self.assertEqual(2, result.returncode)
                remove_tree(self.root)
                self.root.mkdir()

    def test_forged_and_replayed_test_events_are_rejected(self) -> None:
        key = bytes(range(32))
        payload = json.dumps({"type": "started"}, separators=(",", ":"))
        mac = hmac.new(
            key, b"0\n" + payload.encode(), hashlib.sha256).hexdigest()
        events = self.root / "events.jsonl"
        events.write_text(json.dumps({
            "sequence": 0, "payload": payload, "mac": mac}) + "\n",
            encoding="utf-8")
        valid = run_driver("--verify-events", key.hex(), events)
        self.assertEqual(0, valid.returncode, valid.stdout + valid.stderr)
        for mutation in ("forged", "replayed"):
            with self.subTest(mutation=mutation):
                rows = events.read_text(encoding="utf-8")
                if mutation == "forged":
                    envelope = json.loads(rows)
                    envelope["payload"] = json.dumps(
                        {"type": "completed"}, separators=(",", ":"))
                    rows = json.dumps(envelope) + "\n"
                else:
                    rows += rows
                events.write_text(rows, encoding="utf-8")
                result = run_driver("--verify-events", key.hex(), events)
                self.assertEqual(2, result.returncode)
                events.write_text(json.dumps({
                    "sequence": 0, "payload": payload, "mac": mac}) + "\n",
                    encoding="utf-8")


class PostSetupMutationTests(unittest.TestCase):
    def setUp(self) -> None:
        suffix = self.id().rsplit(".", 1)[-1]
        self.root = REPO / "build" / f".stage2-mutation-test-{suffix}"
        remove_tree(self.root)
        self.root.mkdir()

    def tearDown(self) -> None:
        remove_tree(self.root)

    def manifest(self, names: list[str]) -> Path:
        rows = []
        for name in names:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name, encoding="utf-8")
            rows.append({
                "path": name,
                "mode": path.stat().st_mode & 0o7777,
                "size": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            })
        manifest = self.root.parent / f"{self.root.name}.json"
        manifest.write_text(json.dumps(rows), encoding="utf-8")
        self.addCleanup(manifest.unlink, missing_ok=True)
        return manifest

    def assert_mutation_rejected(self, name: str, delete: bool = False) -> None:
        names = [
            "App.gsproj", "hidden.targets", "reference.dll", "analyzer.dll",
            "generated.g.cs", "compiler.dll", "task.dll", "package.nupkg",
            "accepted-output.dll", "test-output.dll", "Tests.gsproj",
        ]
        manifest = self.manifest(names)
        target = self.root / name
        if delete:
            target.unlink()
        else:
            target.write_text("mutated", encoding="utf-8")
        result = run_driver("--verify-manifest", self.root, manifest)
        self.assertEqual(2, result.returncode)
        self.assertIn("manifest changed", result.stderr)

    def test_post_dependency_and_test_setup_graph_changes_are_rejected(self) -> None:
        for name in ("App.gsproj", "hidden.targets", "Tests.gsproj"):
            with self.subTest(name=name):
                self.assert_mutation_rejected(name)
                remove_tree(self.root)
                self.root.mkdir()

    def test_destroyed_explicit_and_isolated_compilation_inputs_are_rejected(self) -> None:
        for name in ("reference.dll", "analyzer.dll", "generated.g.cs"):
            with self.subTest(name=name):
                self.assert_mutation_rejected(name, delete=True)
                remove_tree(self.root)
                self.root.mkdir()

    def test_replaced_toolchain_package_and_output_are_rejected(self) -> None:
        for name in (
            "compiler.dll", "task.dll", "package.nupkg", "accepted-output.dll",
            "test-output.dll",
        ):
            with self.subTest(name=name):
                self.assert_mutation_rejected(name)
                remove_tree(self.root)
                self.root.mkdir()


class PackageCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        suffix = self.id().rsplit(".", 1)[-1]
        self.root = REPO / "build" / f".stage2-package-test-{suffix}"
        remove_tree(self.root)
        self.source = self.root / "source"
        self.destination = self.root / "destination"
        self.source.mkdir(parents=True)
        self.package = self.source / "example.1.0.0.nupkg"
        with zipfile.ZipFile(self.package, "w") as archive:
            archive.writestr("lib/net10.0/example.dll", b"accepted")
        self.content_hash = base64.b64encode(
            hashlib.sha512(self.package.read_bytes()).digest()).decode()
        (self.source / "example.1.0.0.nupkg.sha512").write_text(
            self.content_hash, encoding="utf-8")

    def tearDown(self) -> None:
        remove_tree(self.root)

    def test_verified_archive_replaces_untrusted_extracted_cache_files(self) -> None:
        (self.source / "lib").mkdir()
        (self.source / "lib" / "example.dll").write_bytes(b"forged")
        result = run_driver(
            "--verify-package-cache", self.source, self.destination)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual(
            b"accepted",
            (self.destination / "lib/net10.0/example.dll").read_bytes())

    def test_changed_package_archive_commitment_is_rejected(self) -> None:
        self.package.write_bytes(self.package.read_bytes() + b"changed")
        result = run_driver(
            "--verify-package-cache", self.source, self.destination)
        self.assertEqual(2, result.returncode)
        self.assertIn("hash is invalid", result.stderr)

    def test_replaced_archive_and_sidecar_differ_from_lock_content_hash(self) -> None:
        self.package.write_bytes(self.package.read_bytes() + b"changed")
        replacement_hash = base64.b64encode(
            hashlib.sha512(self.package.read_bytes()).digest()).decode()
        (self.source / "example.1.0.0.nupkg.sha512").write_text(
            replacement_hash, encoding="utf-8")
        result = run_driver(
            "--verify-package-content", self.package, self.content_hash,
            self.root / "hash-work")
        self.assertEqual(2, result.returncode)
        self.assertIn("differs from the lock", result.stderr)


if __name__ == "__main__":
    unittest.main()
