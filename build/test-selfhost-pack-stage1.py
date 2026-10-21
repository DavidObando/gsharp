#!/usr/bin/env python3
"""Regression tests for build/selfhost-pack-stage1.py (issue #4631, C2)."""

from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import subprocess
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("selfhost_pack_stage1", REPO / "build" / "selfhost-pack-stage1.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/selfhost-pack-stage1.py")
packer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packer)

GENERATED = 'Sdk="Gsharp.NET.Sdk/0.4.1129"'


class SdkPublishGraphTests(unittest.TestCase):
    """Run the repository pack targets against a small native SDK graph."""

    def setUp(self) -> None:
        self.workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        self.root = Path(self.workspace.name)
        write(self.root / "Directory.Build.props", """<Project>
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <GsharpCompilerPackageTargetFramework>net10.0</GsharpCompilerPackageTargetFramework>
    <BaseOutputPath>$(MSBuildThisFileDirectory)out/$(Configuration)/</BaseOutputPath>
    <BaseIntermediateOutputPath>$(MSBuildThisFileDirectory)obj/$(MSBuildProjectName)/</BaseIntermediateOutputPath>
    <OutputPath>$(BaseOutputPath)$(MSBuildProjectName)/</OutputPath>
    <AppendTargetFrameworkToOutputPath>false</AppendTargetFrameworkToOutputPath>
    <IntermediateOutputPath Condition="'$(GsharpObjRoot)' != ''">$(GsharpObjRoot)/$(MSBuildProjectName)/</IntermediateOutputPath>
    <NuGetAudit>false</NuGetAudit>
  </PropertyGroup>
</Project>""")
        write(self.root / "Directory.Build.targets", "<Project/>")
        write(self.root / "Shared/Shared.csproj", '<Project Sdk="Microsoft.NET.Sdk"/>')
        write(self.root / "Shared/Value.cs", "public class Value { public static int Number => 42; }")
        products = {
            "Compiler": "src/Compiler/Compiler.gsproj",
            "Gsfmt.Cli": "src/Formatting/Gsfmt.Cli/Gsfmt.Cli.gsproj",
            "Gsgen.Cli": "tools/gsgen/Gsgen.Cli/Gsgen.Cli.gsproj",
        }
        for name, relative in products.items():
            product = REPO / relative
            imports = [node for node in ET.parse(product).getroot().findall("Import")
                       if node.get("Project", "").endswith("sdk-publish.targets")]
            self.assertEqual(1, len(imports), relative)
            imported = imports[0]
            imported.set("Project", str((product.parent / imported.attrib["Project"]).resolve()))
            import_xml = ET.tostring(imported, encoding="unicode")
            write(self.root / f"{name}/{name}.csproj", f"""<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><OutputType>Exe</OutputType></PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Shared/Shared.csproj"/>
    <None Include="nested/payload.txt" CopyToOutputDirectory="PreserveNewest" CopyToPublishDirectory="PreserveNewest"/>
  </ItemGroup>
  {import_xml}
</Project>""")
            write(self.root / f"{name}/Program.cs", "System.Console.WriteLine(Value.Number);")
            write(self.root / f"{name}/nested/payload.txt", name)
        source = ET.parse(REPO / "src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj").getroot()
        driver = ET.Element("Project", {"Sdk": "Microsoft.NET.Sdk"})
        properties = ET.SubElement(driver, "PropertyGroup")
        for name, value in (("GeneratePackageOnBuild", "true"), ("IncludeBuildOutput", "false"),
                            ("SuppressDependenciesWhenPacking", "true")):
            ET.SubElement(properties, name).text = value
        references = ET.SubElement(driver, "ItemGroup")
        target_names = ("PackGsharpCompiler", "PackGsharpFormatter", "PackGsgen")
        for name, target_name in zip(("Compiler", "Gsfmt.Cli", "Gsgen.Cli"), target_names):
            child = str(self.root / name / f"{name}.csproj")
            ET.SubElement(references, "ProjectReference", {
                "Include": child, "ReferenceOutputAssembly": "false",
                "SkipGetTargetFrameworkProperties": "true",
            })
            target = source.find(f"./Target[@Name='{target_name}']")
            assert target is not None
            for task in target.findall("MSBuild"):
                if task.get("Targets") == "Publish":
                    task.set("Projects", child)
            driver.append(target)
        ET.SubElement(ET.SubElement(driver, "ItemGroup"), "ProjectReferenceTargets",
                      {"Include": "Stage", "Targets": "Build"})
        stage = ET.SubElement(driver, "Target", {
            "Name": "Stage", "DependsOnTargets": "Build;" + ";".join(target_names),
        })
        ET.SubElement(stage, "WriteLinesToFile", {
            "File": "$(MSBuildProjectDirectory)/manifest.txt",
            "Lines": "@(_GsharpCompilerPayload);@(_GsharpFormatterPayload);@(_GsgenPayload)",
            "Overwrite": "true",
        })
        write(self.root / "Driver/Driver.csproj", ET.tostring(driver, encoding="unicode"))

    def dotnet(self, *args: str, success: bool = True) -> str:
        env = dict(os.environ, MSBUILDDISABLENODEREUSE="1",
                   DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER="1")
        result = subprocess.run(
            ["dotnet", *args, "-m:1", "-nr:false", "-p:UseSharedCompilation=false"],
            cwd=self.root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=120)
        if success:
            self.assertEqual(0, result.returncode, result.stdout[-12000:])
        else:
            self.assertNotEqual(0, result.returncode, result.stdout[-12000:])
        return result.stdout

    def stage(self, configuration: str = "Release", *properties: str) -> str:
        return self.dotnet("msbuild", "Driver/Driver.csproj", "-restore", "-graph",
                           "-t:Stage", f"-p:Configuration={configuration}", "-v:normal", *properties)

    def test_cold_changed_noop_and_publish_closure_use_the_reference_build(self) -> None:
        first = self.stage()
        # Shared, three apps, and Driver each compile once, not once per publish graph.
        self.assertEqual(5, len(re.findall(r"^\s*CoreCompile:", first, re.MULTILINE)), first)
        self.assertNotIn("staging-obj", first)
        manifest = (self.root / "Driver/manifest.txt").read_text().splitlines()
        self.assertTrue(manifest)
        for name in ("Compiler", "Gsfmt.Cli", "Gsgen.Cli"):
            files = [Path(line) for line in manifest if f"/{name}/" in line]
            self.assertTrue(files, manifest)
            names = {path.name for path in files}
            self.assertTrue({f"{name}.dll", f"{name}.pdb", f"{name}.deps.json",
                             f"{name}.runtimeconfig.json", "Shared.dll", "Shared.pdb",
                             "payload.txt"}.issubset(names), names)
            self.assertTrue(all(path.is_file() for path in files))
            payload = next(path for path in files if path.name == "payload.txt")
            self.assertEqual("nested", payload.parent.name)
            self.assertEqual(name, payload.read_text())
        packages = list((self.root / "out/Release/Driver").glob("*.nupkg"))
        self.assertEqual(1, len(packages))
        with zipfile.ZipFile(packages[0]) as archive:
            entries = {str(Path(name)): name for name in archive.namelist()}
            for folder, name in (("compiler", "Compiler"), ("formatter", "Gsfmt.Cli"),
                                 ("gsgen", "Gsgen.Cli")):
                self.assertEqual(name.encode(), archive.read(entries[f"tools/{folder}/payload.txt"]))
                for suffix in (".dll", ".pdb", ".runtimeconfig.json", ".deps.json"):
                    self.assertIn(f"tools/{folder}/{name}{suffix}", entries)
        normal = self.root / "out/Release/Shared/Shared.dll"
        before = normal.read_bytes()
        write(self.root / "Shared/Value.cs", "public class Value { public static int Number => 43; }")
        changed = self.stage()
        self.assertNotEqual(before, normal.read_bytes())
        for line in manifest:
            if line.endswith("/Shared.dll"):
                self.assertEqual(normal.read_bytes(), Path(line).read_bytes())
        compiler = next(line for line in manifest if line.endswith("/Compiler.dll"))
        result = subprocess.run(["dotnet", compiler], cwd=self.root, capture_output=True,
                                text=True, timeout=30)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("43", result.stdout.strip())
        self.assertNotIn("staging-obj", changed)
        noop = self.stage()
        self.assertNotIn("staging-obj", noop)
        self.assertNotIn("csc.dll", noop)
        # Remove obsolete publication files without writing into the build output.
        obsolete = next(Path(line).parent for line in manifest if line.endswith("/Compiler.dll")) / "obsolete.dll"
        obsolete.write_text("stale")
        self.stage()
        self.assertFalse(obsolete.exists())
        self.assertFalse((normal.parent / "obsolete.dll").exists())
        flagged = self.stage("Release", "-p:Version=2.0.0")
        self.assertEqual(5, len(re.findall(r"^\s*CoreCompile:", flagged, re.MULTILINE)), flagged)
        self.assertNotIn("staging-obj", flagged)
        self.assertNotIn("csc.dll", self.stage("Release", "-p:Version=2.0.0"))
        release = normal.read_bytes()
        self.stage("Debug")
        self.assertEqual(release, normal.read_bytes())
        debug = (self.root / "Driver/manifest.txt").read_text().splitlines()
        self.assertTrue(debug)
        self.assertTrue(all("/Debug/" in line for line in debug), debug)

    def test_direct_pack_target_builds_then_stages(self) -> None:
        output = self.dotnet("msbuild", "Driver/Driver.csproj", "-restore",
                             "-t:PackGsharpCompiler", "-p:Configuration=Debug", "-v:normal")
        self.assertNotIn("staging-obj", output)
        self.assertTrue((self.root / "obj/Compiler/Debug/sdk-publish/Compiler.dll").is_file())

    def test_different_publish_settings_do_not_reuse_the_normal_graph(self) -> None:
        for prop, value in (("TargetFramework", "net9.0"), ("SelfContained", "true"),
                            ("PublishReadyToRun", "true"), ("PublishSingleFile", "true"),
                            ("PublishAot", "true"), ("PublishTrimmed", "true"),
                            ("PublishDir", str(self.root / "custom-publish")),
                            ("NoBuild", "true"), ("BuildProjectReferences", "false")):
            with self.subTest(prop=prop):
                output = self.dotnet("msbuild", "Compiler/Compiler.csproj",
                                     "-t:_GsharpGetSdkPublishPayload", f"-p:{prop}={value}",
                                     "-getTargetResult:_GsharpGetSdkPublishPayload")
                self.assertEqual([], json.loads(output[output.index("{"):])[
                    "TargetResults"]["_GsharpGetSdkPublishPayload"]["Items"])

    def test_incompatible_publish_context_uses_the_isolated_graph(self) -> None:
        write(self.root / "Compiler/Compiler.csproj",
              (self.root / "Compiler/Compiler.csproj").read_text().replace(
                  "<OutputType>Exe</OutputType>", "<OutputType>Exe</OutputType><PublishSingleFile>true</PublishSingleFile>"))
        output = self.stage()
        self.assertIn("SDK staging uses an isolated Publish graph for Compiler:", output)
        self.assertIn("gsc-staging", output)
        self.assertTrue((self.root / "Driver/manifest.txt").read_text().strip())

    def test_empty_publish_fails_instead_of_falling_back(self) -> None:
        compiler = self.root / "Compiler/Compiler.csproj"
        compiler.write_text(compiler.read_text().replace("</Project>", """
  <Target Name="RemovePublication" AfterTargets="Publish" Condition="'$(_GsharpSdkPublishCompatible)' == 'true'">
    <RemoveDir Directories="$(PublishDir)"/>
  </Target>
</Project>"""))
        output = self.dotnet("msbuild", "Driver/Driver.csproj", "-restore", "-graph",
                             "-t:Stage", "-p:Configuration=Release", success=False)
        self.assertIn("SDK publish output is empty", output)

    def test_compiler_contents_and_input_membership_invalidate_repository_outputs(self) -> None:
        tool = self.root / "tools/compiler.dll"
        write(tool, "compiler version one")
        write(self.root / "tools/generator.dll", "generator")
        write(self.root / "tools/task.dll", "task")
        write(self.root / "Input.gs", "input")
        write(self.root / "Removed.gs", "removed input")
        write(self.root / "Inputs.proj", f"""<Project DefaultTargets="Build">
  <PropertyGroup>
    <Language>Gsharp</Language>
    <IsTestProject>true</IsTestProject>
    <IntermediateOutputPath>obj/inputs/</IntermediateOutputPath>
    <GsharpCompilerFullPath>$(MSBuildProjectDirectory)/tools/compiler.dll</GsharpCompilerFullPath>
    <GsgenToolFullPath>$(MSBuildProjectDirectory)/tools/generator.dll</GsgenToolFullPath>
    <GsharpToolFullPath>$(MSBuildProjectDirectory)/tools/task.dll</GsharpToolFullPath>
  </PropertyGroup>
  <ItemGroup><Compile Include="Input.gs;Removed.gs"/></ItemGroup>
  <Import Project="{REPO / 'build/gsharp.build.targets'}"/>
  <Target Name="ResolveReferences"/>
  <Target Name="_GsharpResolveAnalyzers"/>
  <Target Name="Build" DependsOnTargets="CoreCompile"/>
  <Target Name="CoreCompile" Inputs="$(MSBuildAllProjects);@(Compile)" Outputs="obj/inputs/result.dll">
    <Message Text="COMPILING_REPOSITORY_INPUTS" Importance="High"/>
    <WriteLinesToFile File="obj/inputs/result.dll" Lines="built" Overwrite="true"/>
  </Target>
</Project>""")
        self.assertIn("COMPILING_REPOSITORY_INPUTS", self.dotnet("msbuild", "Inputs.proj"))
        self.assertNotIn("COMPILING_REPOSITORY_INPUTS", self.dotnet("msbuild", "Inputs.proj"))
        timestamp = tool.stat()
        tool.write_text("compiler version two")
        os.utime(tool, ns=(timestamp.st_atime_ns, timestamp.st_mtime_ns))
        self.assertIn("COMPILING_REPOSITORY_INPUTS", self.dotnet("msbuild", "Inputs.proj"))
        self.assertNotIn("COMPILING_REPOSITORY_INPUTS", self.dotnet("msbuild", "Inputs.proj"))
        inputs = self.root / "Inputs.proj"
        timestamp = inputs.stat()
        inputs.write_text(inputs.read_text().replace("Input.gs;Removed.gs", "Input.gs"))
        os.utime(inputs, ns=(timestamp.st_atime_ns, timestamp.st_mtime_ns))
        self.assertIn("COMPILING_REPOSITORY_INPUTS", self.dotnet("msbuild", "Inputs.proj"))


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
