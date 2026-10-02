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
                ["src/Compiler/Compiler.gsproj", "src/Core/Core.gsproj",
                 "src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj"],
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
                  project('Sdk="Gsharp.NET.Sdk"', '<ItemGroup><PackageReference Include="GSharp.CodeAnalysis.Analyzers.Testing" Version="0.4.1129" /></ItemGroup>'))
            bootstrap = nupkg(root / "feed/Gsharp.NET.Sdk.1.0.0.nupkg", {"x": b""})
            with self.assertRaises(packer.SelfHostError) as raised:
                packer.prepare_tree(tree, bootstrap)
            self.assertIn("GSharp.CodeAnalysis.Analyzers.Testing.1.0.0.nupkg", str(raised.exception))
            # With the sibling beside the bootstrap, the same tree prepares.
            nupkg(root / "feed/GSharp.CodeAnalysis.Analyzers.Testing.1.0.0.nupkg", {"x": b""})
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
