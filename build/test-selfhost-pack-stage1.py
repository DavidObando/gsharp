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


def publication_write(path: Path, target: Path) -> bool:
    return path == target or (path.parent == target.parent
                              and path.name.startswith(f".{target.name}.publish-"))


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
    # Synthetic ZIP fixtures need honest package metadata for identity admission.
    if path.suffix == ".nupkg" and not any(name.endswith(".nuspec") for name in entries):
        package_id = next((name for name in (packer.SDK_ID, packer.ANALYZER_VERIFIER_ID)
                           if path.name.startswith(name + ".")), None)
        if package_id is not None:
            version = path.name[len(package_id) + 1:-len(".nupkg")]
            entries = {**entries, package_id + ".nuspec": (
                f"<package><metadata><id>{package_id}</id><version>{version}</version>"
                "</metadata></package>").encode()}
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

    def test_unterminated_block_comments_report_original_source_location(self) -> None:
        for text in ("/*", "/* unfinished *", " \n /* before JSON\n{}",
                     '{"sdk": {}} /*', '{"text": "/* in string"} /* after JSON',
                     '{"array": [1, /* after comma', '{"array": [1, // line\n /* block'):
            with self.subTest(text=text):
                with self.assertRaises(json.JSONDecodeError) as raised:
                    packer.strip_json_comments(text)
                error = raised.exception
                start = text.rfind("/*")
                self.assertEqual("Unterminated block comment", error.msg)
                self.assertEqual(text, error.doc)
                self.assertEqual(start, error.pos)
                self.assertEqual(text.count("\n", 0, start) + 1, error.lineno)
                self.assertEqual(start - text.rfind("\n", 0, start), error.colno)

    def test_valid_comments_trailing_commas_and_escaped_string_markers_survive(self) -> None:
        value = 'escaped " quote, backslash \\, // line and /* unterminated in string'
        text = ('// before\n{"text": ' + json.dumps(value) + ', /* between */\n'
                '"array": [1, 2, /* closing array */], /* closing object */} // after')
        self.assertEqual({"text": value, "array": [1, 2]}, json.loads(packer.strip_json_comments(text)))


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
                if publication_write(path, tree / packer.CORE_PROJECT):
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
                    if publication_write(path, failed_path):
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
                if publication_write(path, tree / packer.SDK_PROJECT):
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

    def test_unterminated_comments_after_complete_or_partial_changes_are_repairable(self) -> None:
        for failing in (None, "src/Compiler/Compiler.gsproj", packer.SDK_PROJECT.as_posix()):
            for suffix in (b" /*", b"\n/* unfinished block\n still open *"):
                with self.subTest(failing=failing, suffix=suffix), tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    tree = make_tree(root)
                    valid = (tree / "global.json").read_bytes()
                    invalid = b"\xef\xbb\xbf" + valid + suffix
                    (tree / "global.json").write_bytes(invalid)
                    bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
                    completed = ["src/Compiler/Compiler.gsproj", packer.SDK_PROJECT.as_posix(),
                                 packer.CORE_PROJECT.as_posix()]
                    if failing is not None:
                        write_bytes = Path.write_bytes

                        def fail_write(path, data):
                            if publication_write(path, tree / failing):
                                raise OSError("injected pre-comment project write failure")
                            return write_bytes(path, data)

                        with mock.patch.object(Path, "write_bytes", fail_write):
                            code, partial, stderr = self.prepare(tree, bootstrap, root / "partial")
                        self.assertEqual(1, code)
                        self.assertIn("injected pre-comment project write failure", partial["error"])
                        count = completed.index(failing)
                        self.assertEqual(completed[:count], partial["rewrittenPins"])
                        self.assertEqual(invalid, (tree / "global.json").read_bytes())
                        completed = completed[count:]
                    code, failed, stderr = self.prepare(tree, bootstrap, root / "malformed")
                    self.assertEqual(1, code)
                    self.assert_parse_failure(tree, failed, stderr, invalid, completed)
                    self.assertIn("Unterminated block comment", failed["error"])
                    (tree / "global.json").write_bytes(valid)
                    code, repaired, stderr = self.prepare(tree, bootstrap, root / "repaired")
                    self.assertEqual(0, code, repaired)
                    self.assertEqual("", stderr)
                    self.assertEqual([], repaired["rewrittenPins"])
                    packer.check_no_versioned_toolchain_pins(tree)
                    code, again, stderr = self.prepare(tree, bootstrap, root / "again")
                    self.assertEqual(0, code, again)
                    self.assertEqual([], again["rewrittenPins"])
                    self.assertFalse(again["globalJsonUpdated"])


class AtomicPublicationTests(unittest.TestCase):
    def prepare(self, tree: Path, bootstrap: Path, out: Path) -> tuple[int, dict]:
        return NormalizationRetryTests.prepare(self, tree, bootstrap, out)

    def snapshot(self, path: Path):
        if not path.exists():
            return None
        data = path.read_bytes()
        info = path.stat()
        return data, info.st_mode, info.st_mtime_ns

    def assert_clean_staging(self, root: Path) -> None:
        self.assertEqual([], list(root.rglob("*.publish-*")))

    def test_late_truncation_and_partial_text_writes_never_publish_and_retry_really_succeeds(self) -> None:
        order = ["src/Compiler/Compiler.gsproj", packer.SDK_PROJECT.as_posix(), packer.CORE_PROJECT.as_posix()]
        for relative in (*order, "global.json"):
            for kind in ("truncate", "partial"):
                with self.subTest(relative=relative, kind=kind), tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    tree = make_tree(root)
                    target = tree / relative
                    target.chmod(0o640)
                    before = self.snapshot(target)
                    core = self.snapshot(tree / packer.CORE_PROJECT)
                    bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b"source"})
                    source = bootstrap.read_bytes()
                    write_bytes = Path.write_bytes
                    observed = []

                    def fail_late(path, data):
                        if publication_write(path, target):
                            write_bytes(path, b"" if kind == "truncate" else data[:len(data) // 2])
                            observed.append(self.snapshot(target))
                            raise OSError("injected AFTER actual truncation/partial bytes")
                        return write_bytes(path, data)

                    with mock.patch.object(Path, "write_bytes", fail_late):
                        code, failed = self.prepare(tree, bootstrap, root / "failed")
                    self.assertEqual(1, code)
                    self.assertIn("AFTER actual truncation/partial bytes", failed["error"])
                    self.assertEqual([before], observed)
                    self.assertEqual(before, self.snapshot(target))
                    expected = order if relative == "global.json" else order[:order.index(relative)]
                    self.assertEqual(expected, failed["rewrittenPins"])
                    if relative != "global.json":
                        self.assertEqual(core, self.snapshot(tree / packer.CORE_PROJECT))
                    self.assertNotIn("globalJsonUpdated", failed)
                    self.assertNotIn("stagedPackages", failed)
                    self.assertEqual(source, bootstrap.read_bytes())
                    self.assert_clean_staging(tree)
                    code, repaired = self.prepare(tree, bootstrap, root / "repaired")
                    self.assertEqual(0, code, repaired)
                    self.assertEqual(order[len(expected):], repaired["rewrittenPins"])
                    self.assertEqual(0o640, target.stat().st_mode & 0o777)
                    code, again = self.prepare(tree, bootstrap, root / "again")
                    self.assertEqual(0, code, again)
                    self.assertEqual([], again["rewrittenPins"])
                    self.assertFalse(again["globalJsonUpdated"])
                    self.assert_clean_staging(tree)

    def test_actual_text_close_failures_do_not_publish(self) -> None:
        for relative in (packer.CORE_PROJECT.as_posix(), "global.json"):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                tree = make_tree(root)
                target = tree / relative
                before = self.snapshot(target)
                bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
                original_open = Path.open

                class LateClose:
                    def __init__(self, stream):
                        self.stream = stream

                    def __enter__(self):
                        return self.stream.__enter__()

                    def __exit__(self, *args):
                        self.stream.__exit__(*args)
                        raise OSError("injected AFTER actual data write and file close")

                def fail_close(path, mode="r", *args, **kwargs):
                    stream = original_open(path, mode, *args, **kwargs)
                    return LateClose(stream) if mode == "wb" and publication_write(path, target) else stream

                with mock.patch.object(Path, "open", fail_close):
                    code, failed = self.prepare(tree, bootstrap, root / "failed")
                self.assertEqual(1, code)
                self.assertIn("AFTER actual data write and file close", failed["error"])
                self.assertEqual(before, self.snapshot(target))
                self.assert_clean_staging(tree)
                code, repaired = self.prepare(tree, bootstrap, root / "repaired")
                self.assertEqual(0, code, repaired)
                code, again = self.prepare(tree, bootstrap, root / "again")
                self.assertEqual(0, code, again)
                self.assertEqual([], again["rewrittenPins"])
                self.assertFalse(again["globalJsonUpdated"])

    def test_absent_global_json_and_late_text_metadata_failure_are_not_published(self) -> None:
        for relative, absent in (("global.json", True), ("global.json", False),
                                 (packer.CORE_PROJECT.as_posix(), False)):
            with self.subTest(relative=relative, absent=absent), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                tree = make_tree(root)
                target = tree / relative
                if absent:
                    target.unlink()
                before = self.snapshot(target)
                bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
                write_bytes, copystat = Path.write_bytes, packer.shutil.copystat

                def fail_write(path, data):
                    result = write_bytes(path, data)
                    if publication_write(path, target):
                        raise OSError("injected late new-file write")
                    return result

                def fail_metadata(source, destination, *args, **kwargs):
                    result = copystat(source, destination, *args, **kwargs)
                    if source == target:
                        raise OSError("injected late text metadata copy")
                    return result

                patch = mock.patch.object(Path, "write_bytes", fail_write) if absent else (
                    mock.patch.object(packer.shutil, "copystat", fail_metadata))
                with patch:
                    code, failed = self.prepare(tree, bootstrap, root / "failed")
                self.assertEqual(1, code)
                self.assertIn("injected late", failed["error"])
                self.assertEqual(before, self.snapshot(target))
                self.assert_clean_staging(tree)
                code, repaired = self.prepare(tree, bootstrap, root / "repaired")
                self.assertEqual(0, code, repaired)
                code, again = self.prepare(tree, bootstrap, root / "again")
                self.assertEqual(0, code, again)
                self.assertEqual([], again["rewrittenPins"])
                self.assertFalse(again["globalJsonUpdated"])

    def test_archive_content_and_metadata_failures_preserve_existing_and_absent_destinations(self) -> None:
        for existing in (False, True):
            for failed_index in (0, 1):
                for kind in ("content", "metadata"):
                    with self.subTest(existing=existing, index=failed_index, kind=kind), (
                        tempfile.TemporaryDirectory()) as temp:
                        root = Path(temp)
                        tree = make_tree(root)
                        sources = [nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b"new sdk"}),
                                   nupkg(root / "feed/GSharp.CodeAnalysis.Analyzers.Testing.1.0.0.nupkg",
                                         {"x": b"new verifier"})]
                        target = tree / ".nugs" / sources[failed_index].name
                        target.parent.mkdir()
                        if existing:
                            nupkg(target, {"old": b"old complete archive"})
                            target.chmod(0o640)
                        before = self.snapshot(target)
                        originals = [p.read_bytes() for p in sources]
                        copyfile, copystat = packer.shutil.copyfile, packer.shutil.copystat
                        observed = []

                        def fail_content(source, destination, *args, **kwargs):
                            if source == sources[failed_index]:
                                Path(destination).write_bytes(originals[failed_index][:len(originals[failed_index]) // 2])
                                observed.append(self.snapshot(target))
                                raise OSError("injected AFTER archive partial content")
                            return copyfile(source, destination, *args, **kwargs)

                        def fail_metadata(source, destination, *args, **kwargs):
                            result = copystat(source, destination, *args, **kwargs)
                            if source == sources[failed_index]:
                                observed.append(self.snapshot(target))
                                raise OSError("injected AFTER archive bytes and metadata copy")
                            return result

                        function, replacement = ("copyfile", fail_content) if kind == "content" else ("copystat", fail_metadata)
                        with mock.patch.object(packer.shutil, function, replacement):
                            code, failed = self.prepare(tree, sources[0], root / "failed")
                        self.assertEqual(1, code)
                        self.assertIn("injected AFTER archive", failed["error"])
                        self.assertEqual([before], observed)
                        self.assertEqual(before, self.snapshot(target))
                        self.assertEqual([{"package": sources[0].name, "replacedExisting": False}]
                                         if failed_index else [], failed["stagedPackages"])
                        self.assertEqual(originals, [p.read_bytes() for p in sources])
                        self.assert_clean_staging(tree)
                        code, repaired = self.prepare(tree, sources[0], root / "repaired")
                        self.assertEqual(0, code, repaired)
                        self.assertEqual(originals[failed_index], target.read_bytes())
                        self.assertEqual(existing, repaired["stagedPackages"][failed_index]["replacedExisting"])
                        code, again = self.prepare(tree, sources[0], root / "again")
                        self.assertEqual(0, code, again)
                        self.assertEqual([], again["rewrittenPins"])
                        self.assertFalse(again["globalJsonUpdated"])
                        self.assert_clean_staging(tree)

    def test_permissions_bom_newlines_and_linked_destination_rejection(self) -> None:
        import os
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            core = tree / packer.CORE_PROJECT
            data = core.read_bytes().replace(b"\n", b"\r\n")
            core.write_bytes(data)
            core.chmod(0o640)
            packer.normalize_pins(tree)
            self.assertEqual(data.replace(b"Gsharp.NET.Sdk/0.4.1129", b"Gsharp.NET.Sdk"), core.read_bytes())
            self.assertEqual(0o640, core.stat().st_mode & 0o777)
            linked_source = root / "linked-source"
            linked_source.write_bytes(b"unchanged source")
            for kind in ("symlink", "hardlink", "directory"):
                target = root / kind
                if kind == "symlink":
                    target.symlink_to(linked_source)
                elif kind == "hardlink":
                    os.link(linked_source, target)
                else:
                    target.mkdir()
                with self.subTest(kind=kind), self.assertRaisesRegex(packer.SelfHostError, "single-link regular"):
                    packer.atomic_publish(target, b"must not appear")
                self.assertEqual(b"unchanged source", linked_source.read_bytes())
            real_directory = root / "real-directory"
            real_directory.mkdir()
            alias = root / "directory-alias"
            alias.symlink_to(real_directory, target_is_directory=True)
            aliased_target = alias / "target"
            aliased_target.write_bytes(b"unchanged aliased destination")
            with self.assertRaisesRegex(packer.SelfHostError, "symlinked directory"):
                packer.atomic_publish(aliased_target, b"must not appear")
            self.assertEqual(b"unchanged aliased destination", aliased_target.read_bytes())
            self.assert_clean_staging(root)

    def test_actual_archive_close_failures_preserve_absent_and_existing_targets(self) -> None:
        import builtins
        for existing in (False, True):
            with self.subTest(existing=existing), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                tree = make_tree(root)
                bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b"archive bytes"})
                target = tree / ".nugs" / bootstrap.name
                target.parent.mkdir()
                if existing:
                    nupkg(target, {"old": b"old valid archive"})
                before = self.snapshot(target)
                original_open = builtins.open

                class LateClose:
                    def __init__(self, stream):
                        self.stream = stream

                    def __enter__(self):
                        return self.stream.__enter__()

                    def __exit__(self, *args):
                        self.stream.__exit__(*args)
                        raise OSError("injected AFTER actual archive file close")

                def fail_close(path, mode="r", *args, **kwargs):
                    stream = original_open(path, mode, *args, **kwargs)
                    return LateClose(stream) if mode == "wb" and publication_write(Path(path), target) else stream

                with mock.patch.object(builtins, "open", fail_close):
                    code, failed = self.prepare(tree, bootstrap, root / "failed")
                self.assertEqual(1, code)
                self.assertIn("AFTER actual archive file close", failed["error"])
                self.assertEqual(before, self.snapshot(target))
                self.assertEqual([], failed["stagedPackages"])
                self.assert_clean_staging(tree)
                code, repaired = self.prepare(tree, bootstrap, root / "repaired")
                self.assertEqual(0, code, repaired)
                self.assertEqual(bootstrap.read_bytes(), target.read_bytes())
                code, again = self.prepare(tree, bootstrap, root / "again")
                self.assertEqual(0, code, again)
                self.assertFalse(again["globalJsonUpdated"])

    def test_exclusive_staging_collision_never_removes_an_unowned_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = root / "target"
            target.write_bytes(b"original target")
            foreign = root / ".target.publish-collision"
            foreign.write_bytes(b"not owned by this invocation")
            with mock.patch.object(packer.uuid, "uuid4", return_value=mock.Mock(hex="collision")):
                with self.assertRaises(OSError):
                    packer.atomic_publish(target, b"must not publish")
            self.assertEqual(b"original target", target.read_bytes())
            self.assertEqual(b"not owned by this invocation", foreign.read_bytes())

    def test_symlinked_publication_directory_cannot_mutate_its_target(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            real = root / "real"
            real.mkdir()
            alias = root / "alias"
            alias.symlink_to(real, target_is_directory=True)
            target = alias / "target"
            target.write_bytes(b"unchanged destination")
            with self.assertRaisesRegex(packer.SelfHostError, "symlinked directory"):
                packer.atomic_publish(target, b"must not publish")
            self.assertEqual(b"unchanged destination", target.read_bytes())
            self.assert_clean_staging(root)


class RevisionVersionTests(unittest.TestCase):
    def test_literal_version_contract_is_shared_by_sdk_and_verifier_archives(self) -> None:
        for version in ("1.2.3", "1.2.3.4", "1.2.3.0", "1.2.3.4-beta.1"):
            for package_id in (packer.SDK_ID, packer.ANALYZER_VERIFIER_ID):
                with self.subTest(version=version, package_id=package_id):
                    self.assertEqual(version, packer.package_version(
                        Path(f"{package_id}.{version}.nupkg"), package_id))
                    self.assertEqual(version.split("-", 1)[0] + "-stage1",
                                     packer.default_stage1_version(version))
        for version in ("1.2", "1.2.3.4.5", "1.2.3.4.", "1.2.3.4-alpha..1",
                        "$(Version)", "[1.2.3.4,2.0.0)", "1.2.3.4+build", "1.2.3\n"):
            with self.subTest(version=version), self.assertRaises(packer.SelfHostError):
                packer.package_version(Path(f"{packer.SDK_ID}.{version}.nupkg"))

    def test_literal_revision_references_prepare_at_exact_same_and_cross_sdk_versions(self) -> None:
        import contextlib
        for sdk_version, verifier_version in (
            ("1.2.3.4", "1.2.3.4"), ("1.2.3", "1.2.3.4"),
            ("1.2.3.4", "2.3.4"), ("1.2.3.4", "2.3.4.5-beta.1"),
        ):
            for shape in ("self-closing", "full", "child-namespaced"):
                with self.subTest(sdk=sdk_version, verifier=verifier_version, shape=shape), (
                    tempfile.TemporaryDirectory()) as temp:
                    root = Path(temp)
                    tree = make_tree(root)
                    if shape == "child-namespaced":
                        body = (f'<PackageReference Include="{packer.ANALYZER_VERIFIER_ID}">'
                                f'<Version>{verifier_version}</Version></PackageReference>')
                        namespace = ' xmlns="http://schemas.microsoft.com/developer/msbuild/2003"'
                    else:
                        body = (f'<PackageReference Include="{packer.ANALYZER_VERIFIER_ID}" '
                                f'Version="{verifier_version}"')
                        body += " />" if shape == "self-closing" else "></PackageReference>"
                        namespace = ""
                    write(tree / "test/Verifier.gsproj", f'<Project{namespace}><ItemGroup>{body}</ItemGroup></Project>')
                    bootstrap = nupkg(root / f"feed/{packer.SDK_ID}.{sdk_version}.nupkg", {"x": b"sdk fixture"})
                    sibling = nupkg(root / f"feed/{packer.ANALYZER_VERIFIER_ID}.{verifier_version}.nupkg",
                                    {"x": b"verifier fixture"})
                    args = ["--tree", str(tree), "--bootstrap", str(bootstrap), "--prepare-only",
                            "--out", str(root / "out")]
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        code = packer.main(args)
                    report = json.loads((root / "out/work/stage1-report.json").read_text())
                    self.assertEqual(0, code, report)
                    self.assertNotIn("error", report)
                    self.assertEqual(sdk_version, report["bootstrapVersion"])
                    self.assertEqual(packer.default_stage1_version(sdk_version), report["stage1Version"])
                    self.assertEqual([verifier_version], report["requiredAnalyzerVerifierVersions"])
                    self.assertEqual([], report["missingSiblings"])
                    self.assertEqual([bootstrap.name, sibling.name], [p["package"] for p in report["stagedPackages"]])
                    self.assertEqual(sdk_version, json.loads((tree / "global.json").read_text())["msbuild-sdks"][packer.SDK_ID])
                    self.assertEqual(sibling.read_bytes(), (tree / ".nugs" / sibling.name).read_bytes())
                    again = packer.prepare_tree(tree, bootstrap)
                    self.assertEqual([], again["rewrittenPins"])
                    self.assertFalse(again["globalJsonUpdated"])
                    self.assertEqual([verifier_version], again["requiredAnalyzerVerifierVersions"])

    def test_explicit_stage1_revision_uses_same_literal_validation(self) -> None:
        import contextlib
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.2.3.nupkg", {"x": b"sdk fixture"})
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                code = packer.main(["--tree", str(tree), "--bootstrap", str(bootstrap), "--prepare-only",
                                    "--out", str(root / "out"), "--version", "9.8.7.6-stage1"])
            report = json.loads((root / "out/work/stage1-report.json").read_text())
            self.assertEqual(0, code, report)
            self.assertEqual("9.8.7.6-stage1", report["stage1Version"])
            self.assertEqual("1.2.3", report["bootstrapVersion"])
            self.assertEqual([], report["requiredAnalyzerVerifierVersions"])

    def test_revision_does_not_allow_wrong_sibling_or_evaluated_override_shapes(self) -> None:
        reference = f'<PackageReference Include="{packer.ANALYZER_VERIFIER_ID}" Version="1.2.3.4" />'
        for body in (reference.replace("Version=", "VersionOverride="),
                     reference.replace("/>", "><VersionOverride>1.2.3.4</VersionOverride></PackageReference>"),
                     reference.replace('Version="1.2.3.4"', 'Version="$(VerifierVersion)"'),
                     reference.replace("Include=", "Update=")):
            with self.subTest(body=body), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                tree = make_tree(root)
                write(tree / "test/Verifier.gsproj", f"<Project><ItemGroup>{body}</ItemGroup></Project>")
                bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
                nupkg(root / "feed/GSharp.CodeAnalysis.Analyzers.Testing.1.2.3.4.nupkg", {"x": b""})
                with self.assertRaisesRegex(packer.SelfHostError, "one literal Version"):
                    packer.prepare_tree(tree, bootstrap)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            write(tree / "test/Verifier.gsproj", f"<Project><ItemGroup>{reference}</ItemGroup></Project>")
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
            nupkg(root / "feed/GSharp.CodeAnalysis.Analyzers.Testing.1.2.3.nupkg", {"x": b"wrong revision"})
            report = {}
            with self.assertRaisesRegex(packer.SelfHostError, r"1\.2\.3\.4\.nupkg"):
                packer.prepare_tree(tree, bootstrap, report)
            self.assertEqual(["1.2.3.4"], report["requiredAnalyzerVerifierVersions"])
            self.assertEqual(["GSharp.CodeAnalysis.Analyzers.Testing.1.2.3.4.nupkg"], report["missingSiblings"])
            self.assertNotIn("stagedPackages", report)


class NuGetIdentityTests(unittest.TestCase):
    def prepare(self, tree: Path, bootstrap: Path, out: Path) -> tuple[int, dict]:
        return NormalizationRetryTests.prepare(self, tree, bootstrap, out)

    def package(self, path: Path, package_id: str, version: str, data: bytes = b"fixture") -> Path:
        return nupkg(path, {"x": data, package_id + ".nuspec": (
            f"<package><metadata><id>{package_id}</id><version>{version}</version>"
            "</metadata></package>").encode()})

    def reference(self, tree: Path, versions: list[str]) -> None:
        body = "".join(f'<PackageReference Include="{packer.ANALYZER_VERIFIER_ID}" Version="{v}" />'
                       for v in versions)
        write(tree / "test/Verifier.gsproj", f"<Project><ItemGroup>{body}</ItemGroup></Project>")

    def test_supported_identity_matches_sdk_nuget_versioning_domain(self) -> None:
        for literal, identity in (
            ("1.2.3", "1.2.3"), ("01.002.0003", "1.2.3"),
            ("1.2.3.0", "1.2.3"), ("01.02.003.000", "1.2.3"),
            ("1.2.3.4", "1.2.3.4"), ("1.2.3.0-BETA.1", "1.2.3-beta.1"),
            ("1.2.3-a-01", "1.2.3-a-01"), ("1.2.3-01a", "1.2.3-01a"),
            ("2147483647.1.2", "2147483647.1.2"),
        ):
            with self.subTest(literal=literal):
                self.assertEqual(identity, packer.nuget_version(literal))
        for literal in ("1.2", "1.2.3+metadata", "1.2.3-alpha.01", "2147483648.1.2",
                        "$(Version)", "[1.2.3,2.0.0)", "1.2.3.4.5"):
            with self.subTest(literal=literal), self.assertRaises(packer.SelfHostError):
                packer.nuget_version(literal)

    def test_real_main_accepts_canonical_zero_revision_and_retains_requested_literals(self) -> None:
        for sdk_version, verifier_version, sdk_filename, verifier_filename in (
            ("1.0.0", "3.4.5.0", "1.0.0", "3.4.5"),
            ("3.4.5.0", "3.4.5.0", "3.4.5", "3.4.5"),
            ("01.02.003.000", "03.004.0005.000", "1.2.3", "3.4.5"),
            ("1.0.0", "3.4.5.0-BETA", "1.0.0", "3.4.5-beta"),
        ):
            with self.subTest(sdk=sdk_version, verifier=verifier_version), (
                tempfile.TemporaryDirectory()) as temp:
                root = Path(temp)
                tree = make_tree(root)
                self.reference(tree, [verifier_version])
                bootstrap = self.package(root / f"feed/{packer.SDK_ID}.{sdk_filename}.nupkg",
                                         packer.SDK_ID, sdk_version)
                sibling = self.package(root / f"feed/{packer.ANALYZER_VERIFIER_ID}.{verifier_filename}.nupkg",
                                       packer.ANALYZER_VERIFIER_ID, verifier_version)
                code, report = self.prepare(tree, bootstrap, root / "out")
                self.assertEqual(0, code, report)
                self.assertEqual(sdk_version, report["bootstrapVersion"])
                self.assertEqual(sdk_version.split("-", 1)[0] + "-stage1", report["stage1Version"])
                self.assertEqual([verifier_version], report["requiredAnalyzerVerifierVersions"])
                self.assertEqual([], report["missingSiblings"])
                self.assertEqual([bootstrap.name, sibling.name], [p["package"] for p in report["stagedPackages"]])
                self.assertEqual(sdk_version, json.loads((tree / "global.json").read_text())["msbuild-sdks"][packer.SDK_ID])
                self.assertEqual(sibling.read_bytes(), (tree / ".nugs" / sibling.name).read_bytes())
                code, repeated = self.prepare(tree, bootstrap, root / "repeat")
                self.assertEqual(0, code, repeated)
                self.assertEqual([], repeated["rewrittenPins"])
                self.assertFalse(repeated["globalJsonUpdated"])

    def test_real_main_rejects_stage1_equivalent_identity_before_mutating_tree(self) -> None:
        import contextlib
        for bootstrap_version, stage1 in (
            ("1.2.3", "1.2.3.0"), ("1.2.3.0", "01.02.003"),
            ("1.2.3-BETA", "1.2.3.0-beta"), ("01.02.003.0-BETA.1", "1.2.3-beta.1"),
        ):
            with self.subTest(bootstrap=bootstrap_version, stage1=stage1), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                tree = make_tree(root)
                before = {p.relative_to(tree): p.read_bytes() for p in tree.rglob("*") if p.is_file()}
                bootstrap = nupkg(root / f"feed/{packer.SDK_ID}.{bootstrap_version}.nupkg", {"x": b"fixture"})
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    code = packer.main(["--tree", str(tree), "--bootstrap", str(bootstrap),
                                        "--version", stage1, "--out", str(root / "out"), "--prepare-only"])
                report = json.loads((root / "out/work/stage1-report.json").read_text())
                self.assertEqual(1, code, report)
                self.assertIn("must differ", report.get("error", ""))
                self.assertEqual(before, {p.relative_to(tree): p.read_bytes() for p in tree.rglob("*") if p.is_file()})

    def test_real_main_rejects_filename_or_id_metadata_mismatch(self) -> None:
        for package_id, metadata_id, metadata_version in (
            (packer.SDK_ID, packer.SDK_ID, "1.2.3.4"),
            (packer.SDK_ID, "Other.Package", "1.2.3"),
            (packer.ANALYZER_VERIFIER_ID, packer.ANALYZER_VERIFIER_ID, "1.2.3.4"),
            (packer.ANALYZER_VERIFIER_ID, "Other.Package", "1.2.3"),
        ):
            with self.subTest(package_id=package_id, metadata=metadata_version, id=metadata_id), (
                tempfile.TemporaryDirectory()) as temp:
                root = Path(temp)
                tree = make_tree(root)
                self.reference(tree, ["1.2.3"])
                bootstrap = nupkg(root / f"feed/{packer.SDK_ID}.1.2.3.nupkg", {"x": b"sdk"})
                target = root / f"feed/{package_id}.1.2.3.nupkg"
                self.package(target, metadata_id, metadata_version)
                code, report = self.prepare(tree, bootstrap, root / "out")
                self.assertEqual(1, code, report)
                self.assertTrue(report.get("error"), report)
                self.assertIn("nuspec", report["error"])
                self.assertNotIn("stagedPackages", report)
                if package_id == packer.SDK_ID:
                    self.assertIn(b"Gsharp.NET.Sdk/0.4.1129", (tree / packer.CORE_PROJECT).read_bytes())
                else:
                    self.assertEqual(["src/Compiler/Compiler.gsproj", packer.SDK_PROJECT.as_posix(),
                                      packer.CORE_PROJECT.as_posix()], report["rewrittenPins"])

    def test_real_main_rejects_byte_different_equivalent_input_archives(self) -> None:
        for package_id in (packer.SDK_ID, packer.ANALYZER_VERIFIER_ID):
            with self.subTest(package_id=package_id), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                tree = make_tree(root)
                self.reference(tree, ["1.2.3"])
                bootstrap = nupkg(root / f"feed/{packer.SDK_ID}.1.2.3.nupkg", {"x": b"sdk"})
                nupkg(root / f"feed/{package_id}.1.2.3.nupkg", {"x": b"first"})
                nupkg(root / f"feed/{package_id}.01.02.003.0.nupkg", {"x": b"other"})
                code, report = self.prepare(tree, bootstrap, root / "out")
                self.assertEqual(1, code, report)
                self.assertIn("ambiguous", report.get("error", ""))
                self.assertNotIn("stagedPackages", report)

    def test_real_main_equivalent_references_and_identical_aliases_stage_once(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            versions = ["3.4.5.0", "03.004.0005.000", "3.4.5"]
            self.reference(tree, versions)
            bootstrap = nupkg(root / f"feed/{packer.SDK_ID}.1.0.0.nupkg", {"x": b"sdk"})
            sibling = nupkg(root / f"feed/{packer.ANALYZER_VERIFIER_ID}.3.4.5.nupkg", {"x": b"verifier"})
            alias = sibling.with_name(f"{packer.ANALYZER_VERIFIER_ID}.3.4.5.0.nupkg")
            alias.write_bytes(sibling.read_bytes())
            code, report = self.prepare(tree, bootstrap, root / "out")
            self.assertEqual(0, code, report)
            self.assertEqual(sorted(versions), report["requiredAnalyzerVerifierVersions"])
            self.assertEqual([bootstrap.name, sibling.name], [p["package"] for p in report["stagedPackages"]])
            self.assertFalse((tree / ".nugs" / alias.name).exists())

    def test_real_main_detects_differing_alias_already_in_feed_without_publishing(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = make_tree(root)
            self.reference(tree, ["3.4.5.0"])
            bootstrap = nupkg(root / f"feed/{packer.SDK_ID}.1.0.0.nupkg", {"x": b"sdk"})
            sibling = nupkg(root / f"feed/{packer.ANALYZER_VERIFIER_ID}.3.4.5.nupkg", {"x": b"verifier"})
            alias = nupkg(tree / f".nugs/{packer.ANALYZER_VERIFIER_ID}.3.4.5.0.nupkg", {"x": b"conflicting"})
            before = alias.read_bytes()
            code, report = self.prepare(tree, bootstrap, root / "out")
            self.assertEqual(1, code, report)
            self.assertIn("ambiguous", report.get("error", ""))
            self.assertEqual(before, alias.read_bytes())
            self.assertFalse((tree / ".nugs" / sibling.name).exists())
            self.assertEqual([bootstrap.name], [p["package"] for p in report["stagedPackages"]])

    def test_produced_filename_is_normalized_but_stamped_literal_is_retained(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            produced = nupkg(root / f"{packer.SDK_ID}.0.4.0-g.nupkg", {"x": b"producer fixture"})
            nupkg(produced.with_suffix(".snupkg"), {
                packer.SDK_ID + ".nuspec": b"<package><metadata><version>0.4.0-g</version></metadata></package>"})
            stamped = packer.reversion(produced, "03.004.0005.000-BETA")
            self.assertEqual(f"{packer.SDK_ID}.3.4.5-beta.nupkg", stamped.name)
            self.assertTrue(stamped.with_suffix(".snupkg").exists())
            with zipfile.ZipFile(stamped) as archive:
                self.assertIn(b"<version>03.004.0005.000-BETA</version>", archive.read(packer.SDK_ID + ".nuspec"))
            bootstrap = nupkg(root / f"{packer.SDK_ID}.1.2.3.nupkg", complete_payload(".cs"))
            alias = nupkg(root / f"{packer.SDK_ID}.01.02.003.0.nupkg", complete_payload(".gs"))
            with self.assertRaisesRegex(packer.SelfHostError, "must differ"):
                packer.verify(alias, bootstrap)


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
