#!/usr/bin/env python3
"""Regression tests for build/cutover.py (issue #3501, cut-over mechanics)."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("cutover", REPO / "build" / "cutover.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/cutover.py")
cutover = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cutover)


def put(root: Path, rel: str, text: str) -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


class TransformTests(unittest.TestCase):
    def test_generate_package_on_build(self):
        new, hit = cutover.enable_generate_package_on_build("<GeneratePackageOnBuild>false</GeneratePackageOnBuild>")
        self.assertTrue(hit)
        self.assertEqual("<GeneratePackageOnBuild>true</GeneratePackageOnBuild>", new)
        self.assertFalse(cutover.enable_generate_package_on_build("<A/>")[1])

    def test_dangling_csproj_only_when_gsproj_exists(self):
        text = 'Projects="a/Compiler.csproj" X="a/Gsharp.Extensions.csproj"'
        exists = lambda lit: (lit.endswith("Gsharp.Extensions.csproj"), lit.endswith("Compiler.csproj"))
        new, changed = cutover.rewrite_dangling_csproj_refs(text, exists)
        self.assertEqual('Projects="a/Compiler.gsproj" X="a/Gsharp.Extensions.csproj"', new)
        self.assertEqual(["a/Compiler.csproj"], changed)

    def test_unpin_sdk_only_the_generated_version(self):
        text = '<Project Sdk="Gsharp.NET.Sdk/0.4.1150">\n<Import Sdk="Gsharp.NET.Sdk/0.4.1150" Project="x"/>'
        new, hit = cutover.unpin_sdk(text, "0.4.1150")
        self.assertTrue(hit)
        self.assertIn('<Project Sdk="Gsharp.NET.Sdk">', new)
        self.assertIn('<Import Sdk="Gsharp.NET.Sdk/0.4.1150"', new)  # imports are not Project pins
        self.assertFalse(cutover.unpin_sdk('<Project Sdk="Gsharp.NET.Sdk/0.4.591">', "0.4.1150")[1])

    def test_global_json_pin_keeps_sdk_section(self):
        out = json.loads(cutover.set_msbuild_sdk_pin('{"sdk":{"version":"10.0.300"}}', "0.4.1150"))
        self.assertEqual("10.0.300", out["sdk"]["version"])
        self.assertEqual("0.4.1150", out["msbuild-sdks"]["Gsharp.NET.Sdk"])

    def test_strip_csharp_only_props(self):
        text = ('<Project>\n  <PropertyGroup>\n    <LangVersion>latest</LangVersion>\n    <X>1</X>\n  </PropertyGroup>\n'
                '  <ItemGroup>\n    <PackageReference Include="StyleCop.Analyzers" Version="1" />\n  </ItemGroup>\n</Project>')
        new, removed = cutover.strip_csharp_only_props(text)
        self.assertNotIn("LangVersion", new)
        self.assertNotIn("StyleCop", new)
        self.assertIn("<X>1</X>", new)
        self.assertEqual(["LangVersion", "StyleCop.Analyzers"], removed)

    def test_solution_listing_and_missing(self):
        sln = 'Project("{FAE04EC0}") = "Core", "src\\Core\\Core.csproj", "{1}"\nProject("{F}") = "Ext", "src\\Ext\\Ext.csproj", "{2}"\n'
        slnx = '<Solution><Project Path="src/Core/Core.gsproj" Type="C#" /></Solution>'
        present = {"src/Core/Core.gsproj", "src/Ext/Ext.csproj"}
        missing = cutover.missing_from_slnx(cutover.solution_projects(sln), cutover.solution_projects(slnx),
                                            lambda rel: rel in present)
        self.assertEqual(["src/Ext/Ext.csproj"], missing)

    def test_rewrite_by_basename_needs_a_gsproj_twin(self):
        text = "dotnet pack src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.csproj App.csproj Gsharp.Extensions.csproj"
        new, changed = cutover.rewrite_by_basename(text, {"Gsharp.NET.Sdk"})
        self.assertEqual("dotnet pack src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj App.csproj Gsharp.Extensions.csproj", new)
        self.assertEqual(["Gsharp.NET.Sdk"], changed)

    def test_solution_folders_are_not_projects(self):
        sln = 'Project("{2150E333}") = "Build", "Build", "{1}"\nProject("{F}") = "A", "src\\A\\A.csproj", "{2}"\n'
        self.assertEqual(["src/A/A.csproj"], cutover.solution_projects(sln))

    def test_filters_and_keep_prefixes(self):
        text = "x=(\n  --exclude samples/A/CSharpApp\n  --exclude src/vs-gsharp/src/VsGsharp/VsGsharp.csproj\n  # --exclude no\n)"
        filters = cutover.parse_project_filters(text)
        self.assertEqual(["--exclude", "samples/A/CSharpApp", "--exclude", "src/vs-gsharp/src/VsGsharp/VsGsharp.csproj"],
                         filters)
        keep = cutover.keep_csharp_prefixes(filters)
        self.assertIn("src/vs-gsharp/src/VsGsharp", keep)
        self.assertTrue(cutover.under("samples/A/CSharpApp/x.cs", keep))
        self.assertFalse(cutover.under("samples/A/CSharpAppX/x.cs", keep))

    def test_real_filter_file_parses(self):
        text = (REPO / "build" / "selfmig-common.sh").read_text()
        filters = cutover.parse_project_filters(text)
        self.assertIn("src/vs-gsharp/src/VsGsharp/VsGsharp.csproj", filters)
        self.assertGreaterEqual(len(filters), 20)

    def test_latest_common_version_is_numeric(self):
        self.assertEqual("0.4.1150", cutover.latest_common_version(
            ["0.4.591", "0.4.1150", "0.4.9-pre"], ["0.4.591", "0.4.1150"]))
        with self.assertRaises(cutover.CutoverError):
            cutover.latest_common_version(["0.4.1"], ["0.4.2"])

    def test_commit_message_carries_sha_tag_and_no_attribution(self):
        msg = cutover.commit_message("abc123", "v0.4.1200", "0.4.1200", "0.4.1200", 4, 5)
        self.assertIn("abc123", msg)
        self.assertIn("v0.4.1200", msg)
        self.assertNotIn("Co-authored", msg)


class TreeTests(unittest.TestCase):
    def make_tree(self, root: Path, *, bootstrap=False, drop_slnx_entry=False) -> Path:
        tree = root / "tree"
        sdk = ('<Project Sdk="Gsharp.NET.Sdk/9.9.9"><PropertyGroup><GeneratePackageOnBuild>false</GeneratePackageOnBuild>'
               '</PropertyGroup><Target><MSBuild Projects="$(MSBuildThisFileDirectory)../../Compiler/Compiler.csproj"/>'
               '</Target></Project>')
        put(tree, cutover.SDK_PROJECT, sdk)
        put(tree, "src/Compiler/Compiler.gsproj", '<Project Sdk="Gsharp.NET.Sdk/9.9.9"><PropertyGroup>'
            '<LangVersion>latest</LangVersion></PropertyGroup></Project>')
        put(tree, "src/LanguageServer/LanguageServer.gsproj", '<Project Sdk="Gsharp.NET.Sdk/9.9.9"/>')
        ext = '<Project Sdk="Gsharp.NET.Sdk/9.9.9">' + (
            '<Import Project="..\\Gsharp.NET.Sdk.Bootstrap\\build\\Gsharp.NET.Sdk.Bootstrap.targets"/>' if bootstrap else "") + '</Project>'
        put(tree, cutover.EXTENSIONS_PROJECT, ext)
        put(tree, "src/vs-gsharp/src/VsGsharp/VsGsharp.csproj",
            '<Project><Target><MSBuild Projects="..\\..\\..\\LanguageServer\\LanguageServer.csproj"/></Target></Project>')
        put(tree, "GSharp.sln", "old")
        entries = '<Project Path="src/Compiler/Compiler.gsproj" />' + (
            "" if drop_slnx_entry else '<Project Path="src/LanguageServer/LanguageServer.gsproj" />')
        put(tree, "GSharp.slnx", f"<Solution>{entries}<Project Path=\"{cutover.EXTENSIONS_PROJECT}\" /></Solution>")
        put(tree, "global.json", '{"sdk":{"version":"10.0.300"}}')
        return tree

    ORIGINAL = ('Project("{F}") = "Compiler", "src\\Compiler\\Compiler.csproj", "{1}"\n'
                'Project("{F}") = "LS", "src\\LanguageServer\\LanguageServer.csproj", "{2}"\n')

    def test_full_hand_fix_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            tree = self.make_tree(Path(tmp))
            problems = cutover.apply_hand_fixes(tree, "9.9.9", self.ORIGINAL, lambda _: None)
            self.assertEqual([], problems)
            sdk = (tree / cutover.SDK_PROJECT).read_text()
            self.assertIn("<GeneratePackageOnBuild>true", sdk)
            self.assertIn("Compiler/Compiler.gsproj", sdk)
            self.assertIn("Sdk=\"Gsharp.NET.Sdk\"", sdk)
            self.assertNotIn("LangVersion", (tree / "src/Compiler/Compiler.gsproj").read_text())
            vs = (tree / "src/vs-gsharp/src/VsGsharp/VsGsharp.csproj").read_text()
            self.assertIn("LanguageServer.gsproj", vs)
            self.assertFalse((tree / "GSharp.sln").exists())
            self.assertEqual("9.9.9", json.loads((tree / "global.json").read_text())["msbuild-sdks"]["Gsharp.NET.Sdk"])
            self.assertIn("*.gs", (tree / ".gitattributes").read_text())

    def test_bootstrap_import_and_missing_slnx_entry_are_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            tree = self.make_tree(Path(tmp), bootstrap=True, drop_slnx_entry=True)
            problems = cutover.apply_hand_fixes(tree, "9.9.9", self.ORIGINAL, lambda _: None)
            self.assertTrue(any("Bootstrap" in p for p in problems), problems)
            self.assertTrue(any("does not list src/LanguageServer" in p for p in problems), problems)

    def test_versioned_pin_that_survives_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            tree = self.make_tree(Path(tmp))
            put(tree, "src/Other/Other.gsproj", '<Project Sdk="Gsharp.NET.Sdk/0.4.591"/>')
            problems = cutover.apply_hand_fixes(tree, "9.9.9", None, lambda _: None)
            self.assertTrue(any("versioned pin" in p for p in problems), problems)

    def test_work_root_overlapping_the_checkout_or_foreign_is_refused(self):
        for root in (REPO, REPO.parent, REPO / "src"):
            with self.assertRaises(cutover.CutoverError, msg=str(root)):
                cutover.Run(cutover.argparse.Namespace(work_root=str(root)))
        with tempfile.TemporaryDirectory(dir=Path.home()) as tmp:
            Path(tmp, "precious.txt").write_text("x")
            with self.assertRaises(cutover.CutoverError):
                cutover.Run(cutover.argparse.Namespace(work_root=tmp))

    def test_work_root_under_tmp_is_refused(self):
        args = cutover.argparse.Namespace(work_root="/tmp/x")
        with self.assertRaises(cutover.CutoverError):
            cutover.Run(args)


if __name__ == "__main__":
    unittest.main()
