#!/usr/bin/env python3
"""Regression tests for build/selfhost-pack-stage1.py (issue #4631, C2)."""

from __future__ import annotations

import importlib.util
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("selfhost_pack_stage1", REPO / "build" / "selfhost-pack-stage1.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/selfhost-pack-stage1.py")
packer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packer)

GENERATED = 'Sdk="Gsharp.NET.Sdk/0.4.1129"'


def project(sdk_attribute: str, body: str = "") -> str:
    return f'<?xml version="1.0" encoding="utf-8"?><Project {sdk_attribute}>\n{body}</Project>\n'


def write(path: Path, text: str, bom: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((b"\xef\xbb\xbf" if bom else b"") + text.encode("utf-8"))


def make_tree(root: Path, core_sdk: str = GENERATED) -> Path:
    tree = root / "tree"
    write(tree / "src/Core/Core.gsproj", project(core_sdk), bom=True)
    write(tree / "src/Compiler/Compiler.gsproj", project(core_sdk))
    write(tree / "src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj",
          project(core_sdk, '  <Import Sdk="Gsharp.NET.Sdk/9.9.9" Project="x" />\n'))
    write(tree / "samples/Trail/Trail.gsproj", project('Sdk="Gsharp.NET.Sdk/0.4.591"'))
    write(tree / "global.json",
          '{\n  // keep me\n  "sdk": { "version": "10.0.300", "rollForward": "latestFeature", },\n}\n')
    return tree


def nupkg(path: Path, entries: dict[str, bytes]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return path


def gs_pdb(*names: str) -> bytes:
    return b"BSJB\x00" + b"\x00".join(name.encode() for name in names) + b"\x00"


def complete_payload(source_extension: str) -> dict[str, bytes]:
    entries = {"Sdk/Sdk.props": b"<Project/>", "Sdk/Sdk.targets": b"<Project/>",
               "build/Gsharp.NET.Sdk.props": b"<Project/>"}
    for stem in packer.GSHARP_COMPILED:
        entries[stem.replace("/compiler/", "/compiler//") + ".dll"] = b"MZ"
        entries[stem.replace("/compiler/", "/compiler//") + ".pdb"] = gs_pdb("Program" + source_extension, "Binder" + source_extension)
    return entries


class NormalizePinsTests(unittest.TestCase):
    def test_generated_pin_becomes_bare_and_intentional_pins_survive(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            tree = make_tree(Path(temp))
            rewritten = packer.normalize_pins(tree)

            self.assertEqual(
                ["src/Compiler/Compiler.gsproj", "src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj",
                 "src/Core/Core.gsproj"],
                rewritten)
            core = (tree / "src/Core/Core.gsproj").read_bytes()
            self.assertTrue(core.startswith(b"\xef\xbb\xbf"), "BOM must be preserved")
            self.assertIn(b'<Project Sdk="Gsharp.NET.Sdk">', core)
            sdk_project = (tree / "src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj").read_text()
            self.assertIn('<Import Sdk="Gsharp.NET.Sdk/9.9.9"', sdk_project, "only the Project element is rewritten")
            self.assertIn('Sdk="Gsharp.NET.Sdk/0.4.591"', (tree / "samples/Trail/Trail.gsproj").read_text())

    def test_global_json_tree_is_left_alone(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            tree = make_tree(Path(temp), core_sdk='Sdk="Gsharp.NET.Sdk"')
            self.assertEqual([], packer.normalize_pins(tree))

    def test_a_tree_without_core_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(packer.SelfHostError):
                packer.normalize_pins(Path(temp))

    def test_a_leftover_versioned_toolchain_pin_is_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            tree = make_tree(Path(temp), core_sdk='Sdk="Gsharp.NET.Sdk"')
            write(tree / "src/Formatting/Gsfmt.Cli/Gsfmt.Cli.gsproj", project('Sdk="Gsharp.NET.Sdk/0.4.7"'))
            with self.assertRaises(packer.SelfHostError) as raised:
                packer.check_no_versioned_toolchain_pins(tree)
            self.assertIn("src/Formatting/Gsfmt.Cli/Gsfmt.Cli.gsproj", str(raised.exception))


    def test_a_failed_prepare_still_records_the_mutations_already_made(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            write(tree / "src/Formatting/Gsfmt.Cli/Gsfmt.Cli.gsproj", project('Sdk="Gsharp.NET.Sdk/0.4.7"'))
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.0.4.1129.nupkg", {"x": b""})
            report: dict = {}

            with self.assertRaises(packer.SelfHostError):
                packer.prepare_tree(tree, bootstrap, report)

            # The generated pin was rewritten and global.json pinned before the check failed.
            self.assertIn("src/Core/Core.gsproj", report["rewrittenPins"])
            self.assertTrue(report["globalJsonUpdated"])
            self.assertEqual("0.4.1129", json.loads((tree / "global.json").read_text())["msbuild-sdks"]["Gsharp.NET.Sdk"])


class GlobalJsonTests(unittest.TestCase):
    def test_pin_is_merged_into_commented_global_json(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            tree = make_tree(Path(temp))
            (tree / "global.json").write_text(
                '{ "sdk": { "version": "10.0.300" }, "msbuild-sdks": { "gsharp.net.sdk": "0.0.1", "X": "1.0.0" }, }')
            packer.pin_global_json(tree, "0.4.1129-g6c4824cbc0")
            document = json.loads((tree / "global.json").read_text())
            self.assertEqual("10.0.300", document["sdk"]["version"])
            self.assertEqual({"X": "1.0.0", "Gsharp.NET.Sdk": "0.4.1129-g6c4824cbc0"}, document["msbuild-sdks"])

    def test_a_bom_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            tree = make_tree(Path(temp))
            (tree / "global.json").write_bytes(b"\xef\xbb\xbf{ \"sdk\": { \"version\": \"10.0.300\" } }")
            packer.pin_global_json(tree, "1.0.0")
            self.assertTrue((tree / "global.json").read_bytes().startswith(b"\xef\xbb\xbf"))

    def test_commas_inside_strings_are_kept(self) -> None:
        text = '{"a": "x, }", "b": [1, 2,], }'
        self.assertEqual({"a": "x, }", "b": [1, 2]}, json.loads(packer.strip_json_comments(text)))

    def test_a_non_object_msbuild_sdks_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            tree = make_tree(Path(temp))
            (tree / "global.json").write_text('{ "msbuild-sdks": "Other/1.0.0" }')
            with self.assertRaises(packer.SelfHostError):
                packer.pin_global_json(tree, "1.0.0")
            self.assertEqual('{ "msbuild-sdks": "Other/1.0.0" }', (tree / "global.json").read_text())

    def test_comment_markers_inside_strings_are_kept(self) -> None:
        self.assertEqual('{"a": "http://x/*y*/"} ', packer.strip_json_comments('{"a": "http://x/*y*/"} // c'))


class PrepareTreeTests(unittest.TestCase):
    def test_mid_scan_failure_retains_each_completed_rewrite(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            # Compiler is rewritten before this read fails; Core must still carry the generated pin.
            bad = tree / "src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj"
            original = bad.read_bytes()
            core = (tree / packer.CORE_PROJECT).read_bytes()
            bad.write_bytes(b"\xff")
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
            report: dict = {}

            with self.assertRaises(UnicodeError):
                packer.prepare_tree(tree, bootstrap, report)

            expected = ["src/Compiler/Compiler.gsproj"]
            self.assertEqual(expected, report.get("rewrittenPins", []))
            for relative in expected:
                self.assertEqual(packer.SDK_ID, packer.project_sdk((tree / relative).read_text(encoding="utf-8-sig")))
            self.assertEqual(core, (tree / packer.CORE_PROJECT).read_bytes())
            self.assertNotIn("globalJsonUpdated", report)
            bad.write_bytes(original)
            retried = packer.prepare_tree(tree, bootstrap)
            self.assertEqual(["src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj", "src/Core/Core.gsproj"],
                             retried["rewrittenPins"])
            packer.check_no_versioned_toolchain_pins(tree)

    def test_mid_staging_failure_retains_completed_copies_in_the_driver_report(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
            sibling = nupkg(root / "feed/GSharp.CodeAnalysis.Analyzers.Testing.1.0.0.nupkg", {"x": b""})
            copy = packer.shutil.copy2

            def fail_sibling(source, target):
                if source == sibling:
                    raise OSError("injected sibling copy failure")
                return copy(source, target)

            import contextlib
            with mock.patch.object(packer.shutil, "copy2", side_effect=fail_sibling), contextlib.redirect_stderr(io.StringIO()):
                code = packer.main(["--tree", str(tree), "--bootstrap", str(bootstrap),
                                    "--out", str(root / "out"), "--prepare-only"])
            report = json.loads((root / "out/work/stage1-report.json").read_text())

            self.assertEqual(1, code)
            self.assertIn("injected sibling copy failure", report["error"])
            self.assertEqual([{"package": bootstrap.name, "replacedExisting": False}], report.get("stagedPackages", []))
            self.assertEqual(bootstrap.read_bytes(), (tree / ".nugs" / bootstrap.name).read_bytes())
            self.assertFalse((tree / ".nugs" / sibling.name).exists())
            self.assertTrue(report["globalJsonUpdated"])

    def test_mid_write_failure_retains_only_successful_rewrites_in_the_driver_report(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
            write_bytes = Path.write_bytes

            def fail_core(path, data):
                if path == tree / packer.CORE_PROJECT:
                    raise OSError("injected Core write failure")
                return write_bytes(path, data)

            import contextlib
            with mock.patch.object(Path, "write_bytes", fail_core), contextlib.redirect_stderr(io.StringIO()):
                code = packer.main(["--tree", str(tree), "--bootstrap", str(bootstrap),
                                    "--out", str(root / "out"), "--prepare-only"])
            report = json.loads((root / "out/work/stage1-report.json").read_text())

            self.assertEqual(1, code)
            self.assertIn("injected Core write failure", report["error"])
            self.assertEqual(["src/Compiler/Compiler.gsproj", "src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj"],
                             report.get("rewrittenPins", []))
            self.assertEqual(packer.SDK_ID, packer.project_sdk((tree / "src/Compiler/Compiler.gsproj").read_text()))
            self.assertEqual(packer.SDK_ID, packer.project_sdk((tree / packer.SDK_PROJECT).read_text()))
            self.assertNotEqual(packer.SDK_ID, packer.project_sdk((tree / packer.CORE_PROJECT).read_text(encoding="utf-8-sig")))
            self.assertNotIn("globalJsonUpdated", report)
            retried = packer.prepare_tree(tree, bootstrap)
            self.assertEqual(["src/Core/Core.gsproj"], retried["rewrittenPins"])
            packer.check_no_versioned_toolchain_pins(tree)

    def test_prepare_stages_the_bootstrap_and_its_sibling_and_pins_once(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.0.4.1129-g6c4824cbc0.nupkg", {"x": b""})
            nupkg(root / "feed/GSharp.CodeAnalysis.Analyzers.Testing.0.4.1129-g6c4824cbc0.nupkg", {"x": b""})

            report = packer.prepare_tree(tree, bootstrap)
            again = packer.prepare_tree(tree, bootstrap)

            self.assertEqual("0.4.1129-g6c4824cbc0", report["bootstrapVersion"])
            self.assertEqual(
                {"Gsharp.NET.Sdk.0.4.1129-g6c4824cbc0.nupkg",
                 "GSharp.CodeAnalysis.Analyzers.Testing.0.4.1129-g6c4824cbc0.nupkg"},
                {p.name for p in (tree / ".nugs").iterdir()})
            document = json.loads((tree / "global.json").read_text())
            self.assertEqual("0.4.1129-g6c4824cbc0", document["msbuild-sdks"]["Gsharp.NET.Sdk"])
            self.assertEqual("latestFeature", document["sdk"]["rollForward"])
            self.assertTrue(report["globalJsonUpdated"])
            self.assertEqual([], report["missingSiblings"])
            self.assertEqual([False, False], [s["replacedExisting"] for s in report["stagedPackages"]])
            # Idempotent: a second run changes nothing and says so.
            self.assertFalse(again["globalJsonUpdated"])
            self.assertEqual([], again["rewrittenPins"])
            self.assertEqual([True, True], [s["replacedExisting"] for s in again["stagedPackages"]])

    def test_a_bootstrap_already_in_the_trees_feed_is_not_copied_onto_itself(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            bootstrap = nupkg(tree / ".nugs/Gsharp.NET.Sdk.0.4.1129-g6c4824cbc0.nupkg", {"x": b""})

            report = packer.prepare_tree(tree, bootstrap)

            self.assertEqual([True], [s["replacedExisting"] for s in report["stagedPackages"]])
            self.assertTrue(bootstrap.exists())

    def test_cross_version_reference_stages_only_its_actual_version(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            write(tree / "test/Verifier.gsproj", project(
                'Sdk="Gsharp.NET.Sdk"',
                f'<ItemGroup><PackageReference Include="{packer.ANALYZER_VERIFIER_ID}" '
                'Version="2.0.0" /></ItemGroup>'))
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
            sibling = nupkg(root / "feed/GSharp.CodeAnalysis.Analyzers.Testing.2.0.0.nupkg", {"actual": b"v2"})

            report = packer.prepare_tree(tree, bootstrap)

            self.assertEqual(["2.0.0"], report["requiredAnalyzerVerifierVersions"])
            self.assertEqual([], report["missingSiblings"])
            self.assertEqual({bootstrap.name, sibling.name}, {p.name for p in (tree / ".nugs").iterdir()})
            self.assertEqual(sibling.read_bytes(), (tree / ".nugs" / sibling.name).read_bytes())

    def test_multiple_literal_versions_namespace_and_metadata_are_staged(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            write(tree / "test/Verifier.csproj",
                  '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">'
                  f'<ItemGroup><PackageReference Include="{packer.ANALYZER_VERIFIER_ID.lower()}">'
                  '<Version>2.0.0</Version></PackageReference></ItemGroup></Project>')
            write(tree / "test/Other.gsproj", project(
                'Sdk="Gsharp.NET.Sdk"',
                f"<ItemGroup><PackageReference Version='3.0.0' Include='{packer.ANALYZER_VERIFIER_ID}' /></ItemGroup>"))
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
            for version in ("2.0.0", "3.0.0"):
                nupkg(root / f"feed/{packer.ANALYZER_VERIFIER_ID}.{version}.nupkg", {"x": version.encode()})

            report = packer.prepare_tree(tree, bootstrap)

            self.assertEqual(["2.0.0", "3.0.0"], report["requiredAnalyzerVerifierVersions"])
            self.assertEqual(3, len(report["stagedPackages"]))

    def test_non_reference_mentions_keep_the_sibling_optional(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            write(tree / "test/Other.gsproj", project(
                'Sdk="Gsharp.NET.Sdk"',
                f'<!-- <PackageReference Include="{packer.ANALYZER_VERIFIER_ID}" Version="2.0.0" /> -->'
                f'<ItemGroup><ProjectReference Include="{packer.ANALYZER_VERIFIER_ID}.csproj" />'
                f'<PackageReference Include="{packer.ANALYZER_VERIFIER_ID}.Other" Version="2.0.0" /></ItemGroup>'))
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})

            report = packer.prepare_tree(tree, bootstrap)

            self.assertEqual([], report["requiredAnalyzerVerifierVersions"])
            self.assertEqual([bootstrap.name], [p["package"] for p in report["stagedPackages"]])
            self.assertEqual([f"{packer.ANALYZER_VERIFIER_ID}.1.0.0.nupkg"], report["missingSiblings"])

    def test_unevaluated_reference_shapes_fail_explicitly(self) -> None:
        reference = f'<PackageReference Include="{packer.ANALYZER_VERIFIER_ID}" Version="2.0.0" />'
        cases = [
            reference.replace('Include=', 'Update='),
            reference.replace('Include=', 'Remove='),
            reference.replace(' Version="2.0.0"', ''),
            reference.replace('Version="2.0.0"', 'Version="$(VerifierVersion)"'),
            reference.replace('Version="2.0.0"', 'Version="[2.0.0,3.0.0)"'),
            reference.replace('Version="2.0.0"', 'Version="2.*"'),
            reference.replace('Version=', 'VersionOverride='),
            reference.replace('/>', 'Condition="true" />'),
            f'<ItemGroup Condition="false">{reference}</ItemGroup>',
            f'<Target Name="Later"><ItemGroup>{reference}</ItemGroup></Target>',
            f'<Choose><When Condition="true"><ItemGroup>{reference}</ItemGroup></When></Choose>',
            reference.replace('/>', '><Version>3.0.0</Version></PackageReference>'),
            reference.replace(' Version="2.0.0" />', '><Version Condition="true">2.0.0</Version></PackageReference>'),
            reference.replace('/>', '><VersionOverride>3.0.0</VersionOverride></PackageReference>'),
            reference.replace(packer.ANALYZER_VERIFIER_ID, '$(VerifierPackage)'),
            reference.replace(packer.ANALYZER_VERIFIER_ID, '@(UnknownVerifierPackage)'),
        ]
        for body in cases:
            with self.subTest(body=body), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                tree = make_tree(root)
                write(tree / "test/Verifier.gsproj", project(
                    'Sdk="Gsharp.NET.Sdk"', f'<ItemGroup>{body}</ItemGroup>'))
                bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
                nupkg(root / "feed/GSharp.CodeAnalysis.Analyzers.Testing.1.0.0.nupkg", {"x": b""})
                report: dict = {}

                with self.assertRaises(packer.SelfHostError) as raised:
                    packer.prepare_tree(tree, bootstrap, report)

                self.assertIn("test/Verifier.gsproj", str(raised.exception))
                self.assertIn("PackageReference", str(raised.exception))
                self.assertTrue(report["globalJsonUpdated"])
                self.assertIn("src/Core/Core.gsproj", report["rewrittenPins"])
                self.assertNotIn("stagedPackages", report)

    def test_imported_in_tree_update_is_not_silently_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            write(tree / "test/Verifier.gsproj", project(
                'Sdk="Gsharp.NET.Sdk"',
                f'<ItemGroup><PackageReference Include="{packer.ANALYZER_VERIFIER_ID}" '
                'Version="2.0.0" /></ItemGroup>'))
            write(tree / "Directory.Build.targets",
                  f'<Project><ItemGroup><PackageReference Update="{packer.ANALYZER_VERIFIER_ID}" '
                  'Version="3.0.0" /></ItemGroup></Project>')
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})

            with self.assertRaises(packer.SelfHostError) as raised:
                packer.prepare_tree(tree, bootstrap)

            self.assertIn("Directory.Build.targets", str(raised.exception))
            self.assertIn("Update/Remove", str(raised.exception))

    def test_central_management_and_item_defaults_are_not_evaluated(self) -> None:
        cases = [
            '<PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup>',
            '<PropertyGroup><ManagePackageVersionsCentrally>$(Central)</ManagePackageVersionsCentrally></PropertyGroup>',
            '<ItemDefinitionGroup><PackageReference><VersionOverride>3.0.0</VersionOverride>'
            '</PackageReference></ItemDefinitionGroup>',
        ]
        for defaults in cases:
            with self.subTest(defaults=defaults), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                tree = make_tree(root)
                write(tree / "Directory.Build.props", f'<Project>{defaults}</Project>')
                write(tree / "test/Verifier.gsproj", project(
                    'Sdk="Gsharp.NET.Sdk"',
                    f'<ItemGroup><PackageReference Include="{packer.ANALYZER_VERIFIER_ID}" '
                    'Version="2.0.0" /></ItemGroup>'))
                bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})

                with self.assertRaises(packer.SelfHostError) as raised:
                    packer.prepare_tree(tree, bootstrap)

                self.assertIn("Directory.Build.props", str(raised.exception))
                self.assertIn("unsupported", str(raised.exception))

    def test_known_unrelated_item_aliases_do_not_block_literal_verifier_references(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            write(tree / "Directory.Build.props",
                  '<Project><ItemGroup><OtherPackage Include="Unrelated.Package" Version="3.0.0" />'
                  '<PackageReference Include="@(OtherPackage)" /></ItemGroup></Project>')
            write(tree / "test/Verifier.gsproj", project(
                'Sdk="Gsharp.NET.Sdk"',
                f'<ItemGroup><PackageReference Include="{packer.ANALYZER_VERIFIER_ID}" '
                'Version="2.0.0" /></ItemGroup>'))
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
            nupkg(root / "feed/GSharp.CodeAnalysis.Analyzers.Testing.2.0.0.nupkg", {"x": b""})

            self.assertEqual(["2.0.0"], packer.prepare_tree(tree, bootstrap)["requiredAnalyzerVerifierVersions"])
            # An alias that can carry the verifier cannot supply a guessed version.
            write(tree / "Directory.Build.props",
                  f'<Project><ItemGroup><OtherPackage Include="{packer.ANALYZER_VERIFIER_ID}" Version="3.0.0" />'
                  '<PackageReference Include="@(OtherPackage)" /></ItemGroup></Project>')
            with self.assertRaises(packer.SelfHostError) as raised:
                packer.prepare_tree(tree, bootstrap)
            self.assertIn("Directory.Build.props", str(raised.exception))
            self.assertIn("literal Version", str(raised.exception))

    def test_missing_actual_version_leaves_the_main_failure_report(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            write(tree / "test/Verifier.gsproj", project(
                'Sdk="Gsharp.NET.Sdk"',
                f'<ItemGroup><PackageReference Include="{packer.ANALYZER_VERIFIER_ID}" '
                'Version="2.0.0" /></ItemGroup>'))
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
            nupkg(root / "feed/GSharp.CodeAnalysis.Analyzers.Testing.1.0.0.nupkg", {"x": b""})
            import contextlib
            with contextlib.redirect_stderr(io.StringIO()):
                code = packer.main(["--tree", str(tree), "--bootstrap", str(bootstrap),
                                    "--out", str(root / "out"), "--prepare-only"])
            report = json.loads((root / "out/work/stage1-report.json").read_text())

            self.assertEqual(1, code)
            self.assertEqual(["2.0.0"], report["requiredAnalyzerVerifierVersions"])
            self.assertEqual([f"{packer.ANALYZER_VERIFIER_ID}.2.0.0.nupkg"], report["missingSiblings"])
            self.assertIn(report["missingSiblings"][0], report["error"])
            self.assertTrue(report["globalJsonUpdated"])
            self.assertIn("src/Core/Core.gsproj", report["rewrittenPins"])
            self.assertNotIn("stagedPackages", report)


class NormalizationRetryTests(unittest.TestCase):
    def prepare(self, tree: Path, bootstrap: Path, out: Path) -> tuple[int, dict]:
        import contextlib
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = packer.main(["--tree", str(tree), "--bootstrap", str(bootstrap),
                                "--out", str(out), "--prepare-only"])
        return code, json.loads((out / "work/stage1-report.json").read_text())

    def test_a_repaired_read_failure_allows_a_real_second_prepare(self) -> None:
        for relative in ("src/Compiler/Compiler.gsproj", "src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj"):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                tree = make_tree(root)
                damaged = tree / relative
                original = damaged.read_bytes()
                bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
                damaged.write_bytes(b"\xff")

                code, failed = self.prepare(tree, bootstrap, root / "failed")
                self.assertEqual(1, code)
                self.assertIn("error", failed)
                completed = failed["rewrittenPins"]
                for path in completed:
                    self.assertEqual(packer.SDK_ID, packer.project_sdk((tree / path).read_text(encoding="utf-8-sig")))
                damaged.write_bytes(original)

                code, retried = self.prepare(tree, bootstrap, root / "retried")
                self.assertEqual(0, code, retried)
                self.assertNotIn("error", retried)
                self.assertEqual({bootstrap.name}, {p.name for p in (tree / ".nugs").iterdir()})
                for path in ("src/Compiler/Compiler.gsproj", packer.CORE_PROJECT, packer.SDK_PROJECT):
                    self.assertEqual(packer.SDK_ID, packer.project_sdk((tree / path).read_text(encoding="utf-8-sig")))
                self.assertEqual(3, len(completed) + len(retried["rewrittenPins"]))
                self.assertFalse(set(completed) & set(retried["rewrittenPins"]))
                self.assertEqual("1.0.0", json.loads((tree / "global.json").read_text())["msbuild-sdks"][packer.SDK_ID])

    def test_a_repaired_write_failure_allows_a_real_second_prepare(self) -> None:
        for relative in ("src/Compiler/Compiler.gsproj", "src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj",
                         packer.CORE_PROJECT):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                tree = make_tree(root)
                failed_path = tree / relative
                original = failed_path.read_bytes()
                bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
                write_bytes = Path.write_bytes

                def fail_write(path, data):
                    if path == failed_path:
                        raise OSError("injected normalization write failure")
                    return write_bytes(path, data)

                with mock.patch.object(Path, "write_bytes", fail_write):
                    code, failed = self.prepare(tree, bootstrap, root / "failed")
                self.assertEqual(1, code)
                self.assertIn("injected normalization write failure", failed["error"])
                self.assertEqual(original, failed_path.read_bytes())
                completed = failed["rewrittenPins"]
                for path in completed:
                    self.assertEqual(packer.SDK_ID, packer.project_sdk((tree / path).read_text(encoding="utf-8-sig")))

                code, retried = self.prepare(tree, bootstrap, root / "retried")
                self.assertEqual(0, code, retried)
                self.assertNotIn("error", retried)
                self.assertEqual(3, len(completed) + len(retried["rewrittenPins"]))
                self.assertFalse(set(completed) & set(retried["rewrittenPins"]))
                self.assertEqual(bootstrap.read_bytes(), (tree / ".nugs" / bootstrap.name).read_bytes())
                self.assertTrue((tree / packer.CORE_PROJECT).read_bytes().startswith(b"\xef\xbb\xbf"))
                for path in ("src/Compiler/Compiler.gsproj", packer.CORE_PROJECT, packer.SDK_PROJECT):
                    self.assertEqual(packer.SDK_ID, packer.project_sdk((tree / path).read_text(encoding="utf-8-sig")))
                code, again = self.prepare(tree, bootstrap, root / "again")
                self.assertEqual(0, code, again)
                self.assertEqual([], again["rewrittenPins"])
                self.assertFalse(again["globalJsonUpdated"])

    def test_already_bare_source_still_rejects_unsupported_toolchain_pins(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root, core_sdk='Sdk="Gsharp.NET.Sdk"')
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
            code, valid = self.prepare(tree, bootstrap, root / "valid")
            self.assertEqual(0, code, valid)
            self.assertEqual([], valid["rewrittenPins"])
            unsupported = tree / "src/Formatting/Gsfmt.Cli/Gsfmt.Cli.gsproj"
            write(unsupported, project('Sdk="Gsharp.NET.Sdk/0.4.7"'))
            original = unsupported.read_bytes()
            core = (tree / packer.CORE_PROJECT).read_bytes()

            code, rejected = self.prepare(tree, bootstrap, root / "rejected")

            self.assertEqual(1, code)
            self.assertIn("src/Formatting/Gsfmt.Cli/Gsfmt.Cli.gsproj", rejected["error"])
            self.assertEqual([], rejected["rewrittenPins"])
            self.assertEqual(core, (tree / packer.CORE_PROJECT).read_bytes())
            self.assertEqual(original, unsupported.read_bytes())


class GlobalJsonFailureTests(unittest.TestCase):
    def prepare(self, tree: Path, bootstrap: Path, out: Path) -> tuple[int, dict, str]:
        import contextlib
        stderr = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr):
            code = packer.main(["--tree", str(tree), "--bootstrap", str(bootstrap),
                                "--out", str(out), "--prepare-only"])
        return code, json.loads((out / "work/stage1-report.json").read_text()), stderr.getvalue()

    def assert_parse_failure(self, tree: Path, report: dict, stderr: str, invalid: bytes,
                             rewritten: list[str]) -> None:
        self.assertIn("global.json", report["error"])
        self.assertIn("invalid JSON", report["error"])
        self.assertIn("line", report["error"])
        self.assertIn("column", report["error"])
        self.assertTrue(stderr.strip())
        self.assertNotIn("Traceback", stderr)
        self.assertEqual(rewritten, report["rewrittenPins"])
        self.assertEqual(invalid, (tree / "global.json").read_bytes())
        self.assertNotIn("globalJsonUpdated", report)
        self.assertNotIn("stagedPackages", report)
        for relative in rewritten:
            self.assertEqual(packer.SDK_ID, packer.project_sdk((tree / relative).read_text(encoding="utf-8-sig")))

    def test_malformed_json_after_completed_pin_changes_is_structured_and_repairable(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            valid = (tree / "global.json").read_bytes()
            invalid = b'\xef\xbb\xbf{"sdk": {'
            (tree / "global.json").write_bytes(invalid)
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})

            code, failed, stderr = self.prepare(tree, bootstrap, root / "failed")

            self.assertEqual(1, code)
            self.assert_parse_failure(tree, failed, stderr, invalid,
                                      ["src/Compiler/Compiler.gsproj", packer.SDK_PROJECT.as_posix(),
                                       packer.CORE_PROJECT.as_posix()])
            (tree / "global.json").write_bytes(valid)
            code, repaired, stderr = self.prepare(tree, bootstrap, root / "repaired")
            self.assertEqual(0, code, repaired)
            self.assertEqual("", stderr)
            self.assertNotIn("error", repaired)
            self.assertEqual([], repaired["rewrittenPins"])
            self.assertTrue(repaired["globalJsonUpdated"])
            self.assertEqual(bootstrap.read_bytes(), (tree / ".nugs" / bootstrap.name).read_bytes())
            packer.check_no_versioned_toolchain_pins(tree)
            code, again, stderr = self.prepare(tree, bootstrap, root / "again")
            self.assertEqual(0, code, again)
            self.assertEqual("", stderr)
            self.assertEqual([], again["rewrittenPins"])
            self.assertFalse(again["globalJsonUpdated"])

    def test_malformed_json_after_partial_prior_normalization_keeps_only_actual_mutations(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            valid = (tree / "global.json").read_bytes()
            invalid = b'{"msbuild-sdks": '
            (tree / "global.json").write_bytes(invalid)
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
            write_bytes = Path.write_bytes

            def fail_sdk(path, data):
                if path == tree / packer.SDK_PROJECT:
                    raise OSError("injected pre-parse SDK write failure")
                return write_bytes(path, data)

            with mock.patch.object(Path, "write_bytes", fail_sdk):
                code, partial, stderr = self.prepare(tree, bootstrap, root / "partial")
            self.assertEqual(1, code)
            self.assertIn("injected pre-parse SDK write failure", partial["error"])
            self.assertEqual(["src/Compiler/Compiler.gsproj"], partial["rewrittenPins"])
            self.assertEqual(invalid, (tree / "global.json").read_bytes())
            self.assertNotIn("Traceback", stderr)

            code, failed, stderr = self.prepare(tree, bootstrap, root / "malformed")

            self.assertEqual(1, code)
            self.assert_parse_failure(tree, failed, stderr, invalid,
                                      [packer.SDK_PROJECT.as_posix(), packer.CORE_PROJECT.as_posix()])
            (tree / "global.json").write_bytes(valid)
            code, repaired, stderr = self.prepare(tree, bootstrap, root / "repaired")
            self.assertEqual(0, code, repaired)
            self.assertEqual("", stderr)
            self.assertNotIn("error", repaired)
            self.assertEqual([], repaired["rewrittenPins"])
            packer.check_no_versioned_toolchain_pins(tree)
            code, again, stderr = self.prepare(tree, bootstrap, root / "again")
            self.assertEqual(0, code, again)
            self.assertEqual("", stderr)
            self.assertEqual([], again["rewrittenPins"])
            self.assertFalse(again["globalJsonUpdated"])

    def test_existing_unsupported_json_shapes_fail_without_replacing_configuration(self) -> None:
        for invalid in (b"null", b"[]", b'{"msbuild-sdks": []}', b'{"msbuild-sdks": "Other/1.0.0"}'):
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                tree = make_tree(root)
                (tree / "global.json").write_bytes(invalid)
                bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})

                code, failed, stderr = self.prepare(tree, bootstrap, root / "failed")

                self.assertEqual(1, code)
                self.assertIn("global.json", failed["error"])
                self.assertIn("not a JSON object", failed["error"])
                self.assertNotIn("Traceback", stderr)
                self.assertEqual(invalid, (tree / "global.json").read_bytes())
                self.assertEqual(["src/Compiler/Compiler.gsproj", packer.SDK_PROJECT.as_posix(),
                                  packer.CORE_PROJECT.as_posix()], failed["rewrittenPins"])
                self.assertNotIn("globalJsonUpdated", failed)
                self.assertNotIn("stagedPackages", failed)


class VersionTests(unittest.TestCase):
    def test_versions(self) -> None:
        self.assertEqual("0.4.1129-g6c4824cbc0",
                         packer.package_version(Path("Gsharp.NET.Sdk.0.4.1129-g6c4824cbc0.nupkg")))
        self.assertEqual("0.4.1129-stage1", packer.default_stage1_version("0.4.1129-g6c4824cbc0"))
        with self.assertRaises(packer.SelfHostError):
            packer.package_version(Path("Gsharp.Gsfmt.0.4.1129.nupkg"))
        with self.assertRaises(packer.SelfHostError):
            packer.package_version(Path("Gsharp.NET.Sdk.0.4.1129-alpha..1.nupkg"))

    def test_a_missing_sibling_is_reported(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
            report = packer.prepare_tree(tree, bootstrap)
            self.assertEqual(["GSharp.CodeAnalysis.Analyzers.Testing.1.0.0.nupkg"], report["missingSiblings"])

    def test_a_missing_sibling_is_an_error_when_the_tree_restores_it(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            write(tree / "test/InternalAnalyzers.Tests/InternalAnalyzers.Tests.gsproj",
                  project('Sdk="Gsharp.NET.Sdk"',
                          '<ItemGroup><PackageReference Include="GSharp.CodeAnalysis.Analyzers.Testing" Version="0.4.1129" /></ItemGroup>'))
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
            with self.assertRaises(packer.SelfHostError) as raised:
                packer.prepare_tree(tree, bootstrap)
            self.assertIn("GSharp.CodeAnalysis.Analyzers.Testing.0.4.1129.nupkg", str(raised.exception))
            # A bootstrap-version sibling does not satisfy the actual reference.
            nupkg(root / "feed/GSharp.CodeAnalysis.Analyzers.Testing.1.0.0.nupkg", {"x": b""})
            with self.assertRaises(packer.SelfHostError) as raised:
                packer.prepare_tree(tree, bootstrap)
            self.assertIn("GSharp.CodeAnalysis.Analyzers.Testing.0.4.1129.nupkg", str(raised.exception))
            nupkg(root / "feed/GSharp.CodeAnalysis.Analyzers.Testing.0.4.1129.nupkg", {"x": b""})
            self.assertEqual([], packer.prepare_tree(tree, bootstrap)["missingSiblings"])

    def test_stage1_version_equal_to_bootstrap_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            make_tree(root)
            bootstrap = nupkg(root / "Gsharp.NET.Sdk.0.4.1129.nupkg", {"x": b""})
            stderr = io.StringIO()
            import contextlib
            with contextlib.redirect_stderr(stderr):
                code = packer.main(["--tree", str(root / "tree"), "--bootstrap", str(bootstrap),
                                    "--version", "0.4.1129", "--out", str(root / "out")])
            self.assertEqual(1, code)
            self.assertIn("must differ", stderr.getvalue())
            report = json.loads((root / "out" / "work" / "stage1-report.json").read_text())
            self.assertIn("must differ", report["error"])


class ReversionTests(unittest.TestCase):
    def test_the_package_version_is_stamped_and_the_file_renamed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            produced = nupkg(root / "Gsharp.NET.Sdk.0.4.0-g.nupkg", {
                "Gsharp.NET.Sdk.nuspec": b"<package><metadata><id>Gsharp.NET.Sdk</id><version>0.4.0-g</version></metadata></package>",
                "tools/compiler/gsc.dll": b"MZ"})
            nupkg(root / "Gsharp.NET.Sdk.0.4.0-g.snupkg", {
                "Gsharp.NET.Sdk.nuspec": b"<package><metadata><version>0.4.0-g</version></metadata></package>"})
            same = nupkg(root / "same" / "Gsharp.NET.Sdk.2.0.0.nupkg", {
                "Gsharp.NET.Sdk.nuspec": b"<package><metadata><version>0.0.0-g</version></metadata></package>"})
            packer.reversion(same, "2.0.0")
            with zipfile.ZipFile(same) as archive:
                self.assertIn(b"<version>2.0.0</version>", archive.read("Gsharp.NET.Sdk.nuspec"),
                              "a matching file name must still be stamped")
            versionless = nupkg(root / "other" / "Gsharp.NET.Sdk.1.0.0-g.nupkg", {"Gsharp.NET.Sdk.nuspec": b"<package/>"})
            with self.assertRaises(packer.SelfHostError):
                packer.stamp_package(versionless, root / "other" / "x.nupkg", "1.0.0", required=True)

            stamped = packer.reversion(produced, "0.4.1129-stage1")

            self.assertEqual("Gsharp.NET.Sdk.0.4.1129-stage1.nupkg", stamped.name)
            self.assertEqual(
                ["Gsharp.NET.Sdk.0.4.1129-stage1.nupkg", "Gsharp.NET.Sdk.0.4.1129-stage1.snupkg"],
                sorted(p.name for p in root.iterdir() if p.is_file()))
            with zipfile.ZipFile(root / "Gsharp.NET.Sdk.0.4.1129-stage1.snupkg") as archive:
                self.assertIn(b"<version>0.4.1129-stage1</version>", archive.read("Gsharp.NET.Sdk.nuspec"))
            with zipfile.ZipFile(stamped) as archive:
                self.assertIn(b"<version>0.4.1129-stage1</version>", archive.read("Gsharp.NET.Sdk.nuspec"))
                self.assertEqual(b"MZ", archive.read("tools/compiler/gsc.dll"))


class VerifyTests(unittest.TestCase):
    def test_a_complete_gsharp_compiled_package_verifies(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            bootstrap = nupkg(root / "Gsharp.NET.Sdk.1.0.0.nupkg", complete_payload(".cs"))
            stage1 = nupkg(root / "Gsharp.NET.Sdk.1.0.0-stage1.nupkg", complete_payload(".gs"))
            report = packer.verify(stage1, bootstrap)
            self.assertEqual({stem: "gs" for stem in packer.GSHARP_COMPILED}, report["provenance"])

    def test_a_package_compiled_from_csharp_is_rejected(self) -> None:
        # The deliberately broken input: right layout, wrong compiler input.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            bootstrap = nupkg(root / "Gsharp.NET.Sdk.1.0.0.nupkg", complete_payload(".cs"))
            stage1 = nupkg(root / "Gsharp.NET.Sdk.1.0.0-stage1.nupkg", complete_payload(".cs"))
            with self.assertRaises(packer.SelfHostError) as raised:
                packer.verify(stage1, bootstrap)
            self.assertIn("not compiled from G#", str(raised.exception))

    def test_a_package_missing_payload_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            bootstrap = nupkg(root / "Gsharp.NET.Sdk.1.0.0.nupkg",
                              {**complete_payload(".cs"), "tools/gsgen/gsgen.dll": b"MZ"})
            stage1 = nupkg(root / "Gsharp.NET.Sdk.1.0.0-stage1.nupkg", complete_payload(".gs"))
            with self.assertRaises(packer.SelfHostError) as raised:
                packer.verify(stage1, bootstrap)
            self.assertIn("tools/gsgen/gsgen.dll", str(raised.exception))

    def test_a_missing_xml_doc_is_reported_not_fatal(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            bootstrap = nupkg(root / "Gsharp.NET.Sdk.1.0.0.nupkg",
                              {**complete_payload(".cs"), "tools/compiler//GSharp.Compiler.xml": b"<doc/>"})
            stage1 = nupkg(root / "Gsharp.NET.Sdk.1.0.0-stage1.nupkg", complete_payload(".gs"))
            report = packer.verify(stage1, bootstrap)
            self.assertEqual(["tools/compiler/GSharp.Compiler.xml"], report["missingDocs"])


if __name__ == "__main__":
    unittest.main()
