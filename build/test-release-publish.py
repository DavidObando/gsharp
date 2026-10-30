#!/usr/bin/env python3
"""Tests for build/release-publish.py (ADR-0218, issue #5530).

The script runs as a program (`python3 build/release-publish.py ...`), as the workflow runs it. The artifacts
are built from fake zip files. `dotnet` is a shell script that logs its arguments. The marketplace is a local
HTTP server that answers the extensionquery request.
"""

from __future__ import annotations

import http.server
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "build" / "release-publish.py"

RIDS = ("linux-x64", "linux-arm64", "win-x64", "win-arm64", "osx-x64", "osx-arm64")
OTHERS = ("Gsharp.NET.Sdk", "Gsharp.Templates", "Gsharp.Repl", "Gsharp.Gsfmt", "Gsharp.Cs2Gs",
          "GSharp.CodeAnalysis.Analyzers.Testing")
PROPS = ('<Project><ItemGroup><PackageDownload Include="Gsharp.NET.Sdk.Compiler.$(_GsharpHostRid)"\n'
         '  Version="[$(GsharpSdkVersion)]" /></ItemGroup></Project>')
SDK = "Gsharp.NET.Sdk"
VSIX_NS = "http://schemas.microsoft.com/developer/vsx-schema/2011"


def run(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    full_env = dict(os.environ)
    for name in ("GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"):
        full_env.pop(name, None)
    full_env.update(env or {})
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, env=full_env, check=False)


def write_zip(path: Path, files: dict[str, str | bytes]) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        for name, text in files.items():
            archive.writestr(name, text)


def vsix_manifest(version: str, marker: bool = False) -> str:
    prop = '<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />' if marker else ""
    return (f'<PackageManifest xmlns="{VSIX_NS}"><Metadata><Identity Id="x" Version="{version}" Publisher="p" />'
            f"<Properties>{prop}</Properties></Metadata></PackageManifest>")


def make_packages(folder: Path, version: str = "0.5.212", skip: tuple[str, ...] = (), props: str = PROPS) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for rid in RIDS:
        name = f"Gsharp.NET.Sdk.Compiler.{rid}"
        if name not in skip:
            (folder / f"{name}.{version}.nupkg").write_bytes(b"x")
    for name in OTHERS:
        if name in skip:
            continue
        if name == "Gsharp.NET.Sdk":
            write_zip(folder / f"{name}.{version}.nupkg", {"build/Gsharp.NET.Sdk.props": props})
        else:
            (folder / f"{name}.{version}.nupkg").write_bytes(b"x")
        if name != "Gsharp.Templates":
            (folder / f"{name}.{version}.snupkg").write_bytes(b"x")


def make_vsix(folder: Path, code_version: str = "0.5.212", studio_version: str = "0.5.212.9261",
              marker: bool = False, pin: str = f"{SDK}/0.5.212") -> None:
    folder.mkdir(parents=True, exist_ok=True)
    write_zip(folder / "vscode-gsharp.vsix", {"extension.vsixmanifest": vsix_manifest(code_version, marker)})
    write_zip(folder / "GSharp.VisualStudio.vsix", {
        "extension.vsixmanifest": vsix_manifest(studio_version),
        "ProjectTemplates/GSharp/1033/GSharpConsole/GSharpConsole.gsproj": f'<Project Sdk="{pin}"><PropertyGroup/></Project>',
        "ProjectTemplates/GSharp/1033/GSharpXunit/GSharpLibrary/GSharpLibrary.gsproj": f'<Project Sdk="{pin}"/>',
    })


def make_zipped_template_vsix(folder: Path, pin: str) -> None:
    """The layout of the VsGsharp.csproj source: one template zip per project template."""
    make_vsix(folder, pin=pin)
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as template:
        template.writestr("GSharpConsole.gsproj", f'<Project Sdk="{pin}"/>')
    write_zip(folder / "GSharp.VisualStudio.vsix", {
        "extension.vsixmanifest": vsix_manifest("0.5.212.9261"),
        "ProjectTemplates/GSharp/1033/GSharpConsole.zip": inner.getvalue()})


class TagKindTests(unittest.TestCase):
    def kind(self, ref: str) -> str:
        result = run("tag-kind", ref)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def test_release_tags(self) -> None:
        for ref in ("v0.5.212", "v1.0.0", "v10.20.30"):
            with self.subTest(ref=ref):
                self.assertEqual(self.kind(ref), "release")

    def test_prerelease_tags(self) -> None:
        for ref in ("v0.5.300-rc1", "v0.5.300-beta.2", "v0.5.300-alpha", "v0.5.1-rc1", "v0.5.300-0a", "v0.5.300-x-y.7"):
            with self.subTest(ref=ref):
                self.assertEqual(self.kind(ref), "prerelease")

    def test_everything_else_is_none(self) -> None:
        for ref in ("main", "", "v1", "v1.2", "v01.5.300", "v0.5.300+build", "v0.5.300-rc1+build", "v0.5.300-01",
                    "v0.5.300-alpha..1", "v0.5.300-", "v0.5.300-.a", "0.5.212", "refs/tags/v0.5.212", "v0.5.300-rc1\n",
                    "V0.5.212", "v0.5.212.1"):
            with self.subTest(ref=ref):
                self.assertEqual(self.kind(ref), "none")


class VerifyNugetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        self.root = Path(self.workspace.name)
        self.nupkgs = self.root / "nupkgs"

    def verify(self) -> subprocess.CompletedProcess:
        return run("verify", "--nuget-only", "--nupkgs", str(self.nupkgs))

    def test_complete_set_passes(self) -> None:
        make_packages(self.nupkgs)
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("verified 12 packages and 5 symbol packages at 0.5.212", result.stdout)

    def test_prerelease_version_passes(self) -> None:
        make_packages(self.nupkgs, version="0.5.300-g1a2b3c4")
        self.assertEqual(self.verify().returncode, 0)

    def test_five_rid_packages_fail(self) -> None:
        make_packages(self.nupkgs, skip=("Gsharp.NET.Sdk.Compiler.osx-x64",))
        result = self.verify()
        self.assertEqual(result.returncode, 1)
        self.assertIn("missing package: Gsharp.NET.Sdk.Compiler.osx-x64", result.stderr)

    def test_missing_symbol_package_fails(self) -> None:
        make_packages(self.nupkgs)
        (self.nupkgs / "Gsharp.Repl.0.5.212.snupkg").unlink()
        result = self.verify()
        self.assertEqual(result.returncode, 1)
        self.assertIn("missing symbol package: Gsharp.Repl", result.stderr)

    def test_symbols_for_templates_fail(self) -> None:
        make_packages(self.nupkgs)
        (self.nupkgs / "Gsharp.Templates.0.5.212.snupkg").write_bytes(b"x")
        self.assertIn("unexpected symbol package: Gsharp.Templates", self.verify().stderr)

    def test_extra_and_foreign_files_fail(self) -> None:
        make_packages(self.nupkgs)
        (self.nupkgs / "Extra.Tool.0.5.212.nupkg").write_bytes(b"x")
        (self.nupkgs / "notes.txt").write_bytes(b"x")
        result = self.verify()
        self.assertEqual(result.returncode, 1)
        self.assertIn("unexpected package: Extra.Tool", result.stderr)
        self.assertIn("unexpected file", result.stderr)

    def test_two_versions_fail(self) -> None:
        make_packages(self.nupkgs)
        (self.nupkgs / "Gsharp.Repl.0.5.212.nupkg").rename(self.nupkgs / "Gsharp.Repl.0.5.213.nupkg")
        result = self.verify()
        self.assertEqual(result.returncode, 1)
        self.assertIn("2 versions", result.stderr)

    def test_missing_directory_fails(self) -> None:
        self.assertEqual(self.verify().returncode, 1)

    def test_sdk_props_with_a_different_literal_version_fail(self) -> None:
        make_packages(self.nupkgs, props=PROPS.replace("$(GsharpSdkVersion)", "0.5.1"))
        self.assertIn("PackageDownload version [0.5.1]", self.verify().stderr)

    def test_sdk_props_with_the_package_version_pass(self) -> None:
        make_packages(self.nupkgs, props=PROPS.replace("$(GsharpSdkVersion)", "0.5.212"))
        self.assertEqual(self.verify().returncode, 0)

    def test_sdk_props_ignore_comments_and_attribute_order(self) -> None:
        commented = "<Project><!-- " + PROPS.replace("<Project>", "").replace("</Project>", "") + " --></Project>"
        make_packages(self.nupkgs, props=commented)
        self.assertIn("has no PackageDownload", self.verify().stderr)
        reordered = ('<Project><ItemGroup><PackageDownload Version="[$(GsharpSdkVersion)]" '
                     'Include="Gsharp.NET.Sdk.Compiler.$(_GsharpHostRid)" /></ItemGroup></Project>')
        make_packages(self.nupkgs, props=reordered)
        self.assertEqual(self.verify().returncode, 0)

    def test_sdk_props_without_package_download_fail(self) -> None:
        make_packages(self.nupkgs, props="<Project/>")
        self.assertIn("has no PackageDownload", self.verify().stderr)


class VerifyTagTests(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        self.root = Path(self.workspace.name)
        self.nupkgs = self.root / "nupkgs"
        self.vsix = self.root / "vsix"

    def verify(self, tag: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
        return run("verify", "--nupkgs", str(self.nupkgs), "--vsix", str(self.vsix), "--tag", tag, env=env)

    def test_release_passes_and_writes_outputs(self) -> None:
        make_packages(self.nupkgs)
        make_vsix(self.vsix)
        output = self.root / "output.txt"
        result = self.verify("v0.5.212", env={"GITHUB_OUTPUT": str(output)})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output.read_text(), "version=0.5.212\nprerelease=false\nvscode_version=0.5.212\nvisual_studio_version=0.5.212.9261\n")

    def test_prerelease_passes_with_marker_and_sha_version(self) -> None:
        make_packages(self.nupkgs, version="0.5.300-g1a2b3c4")
        make_vsix(self.vsix, code_version="0.5.300", studio_version="0.5.300.9261", marker=True,
                  pin=f"{SDK}/0.5.300-g1a2b3c4")
        output = self.root / "output.txt"
        result = self.verify("v0.5.300-rc1", env={"GITHUB_OUTPUT": str(output)})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output.read_text(), "version=0.5.300-g1a2b3c4\nprerelease=true\nvscode_version=0.5.300\nvisual_studio_version=0.5.300.9261\n")

    def test_tag_kind_none_fails(self) -> None:
        make_packages(self.nupkgs)
        make_vsix(self.vsix)
        for tag in ("main", "v0.5.212+build", "v0.5.212-01"):
            with self.subTest(tag=tag):
                result = self.verify(tag)
                self.assertEqual(result.returncode, 1)
                self.assertIn("is not a release tag", result.stderr)

    def test_tag_that_differs_from_the_package_version_fails(self) -> None:
        make_packages(self.nupkgs)
        make_vsix(self.vsix)
        result = self.verify("v0.5.213")
        self.assertEqual(result.returncode, 1)
        self.assertIn("needs package version 0.5.213, found 0.5.212", result.stderr)

    def test_release_tag_with_a_prerelease_package_fails(self) -> None:
        make_packages(self.nupkgs, version="0.5.212-g1a2b3c4")
        make_vsix(self.vsix, pin=f"{SDK}/0.5.212-g1a2b3c4")
        self.assertIn("needs package version 0.5.212, found 0.5.212-g1a2b3c4", self.verify("v0.5.212").stderr)

    def test_prerelease_tag_with_a_release_package_fails(self) -> None:
        make_packages(self.nupkgs)
        make_vsix(self.vsix, marker=True)
        self.assertIn("needs package version 0.5.212-g<sha>", self.verify("v0.5.212-rc1").stderr)

    def test_prerelease_tag_number_must_match(self) -> None:
        make_packages(self.nupkgs, version="0.5.299-g1a2b3c4")
        make_vsix(self.vsix, code_version="0.5.299", marker=True, pin=f"{SDK}/0.5.299-g1a2b3c4")
        self.assertIn("needs package version 0.5.300-g<sha>", self.verify("v0.5.300-rc1").stderr)

    def test_marker_must_follow_the_kind(self) -> None:
        make_packages(self.nupkgs)
        make_vsix(self.vsix, marker=True)
        self.assertIn("pre-release marker is present for a release tag", self.verify("v0.5.212").stderr)
        make_packages(self.root / "pre", version="0.5.212-g1a2b3c4")
        make_vsix(self.root / "pre-vsix", pin=f"{SDK}/0.5.212-g1a2b3c4")
        result = run("verify", "--nupkgs", str(self.root / "pre"), "--vsix", str(self.root / "pre-vsix"), "--tag", "v0.5.212-rc1")
        self.assertIn("pre-release marker is absent for a prerelease tag", result.stderr)

    def test_vscode_version_must_equal_the_core(self) -> None:
        make_packages(self.nupkgs)
        make_vsix(self.vsix, code_version="0.5.211")
        self.assertIn("vscode-gsharp.vsix has version '0.5.211', expected 0.5.212", self.verify("v0.5.212").stderr)

    def test_visual_studio_version_is_compared_part_by_part(self) -> None:
        make_packages(self.nupkgs)
        # "0.5.2120.9261" starts with the text "0.5.212" but its third part is 2120.
        make_vsix(self.vsix, studio_version="0.5.2120.9261")
        self.assertIn("GSharp.VisualStudio.vsix has version '0.5.2120.9261'", self.verify("v0.5.212").stderr)
        for bad in ("0.5.212", "0.5.212.x", "0.5.212.1.2"):
            with self.subTest(version=bad):
                make_vsix(self.vsix, studio_version=bad)
                self.assertEqual(self.verify("v0.5.212").returncode, 1)

    def test_templates_must_pin_the_package_version(self) -> None:
        make_packages(self.nupkgs)
        make_vsix(self.vsix, pin=f"{SDK}/0.3.159")
        result = self.verify("v0.5.212")
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"pins '{SDK}/0.3.159', expected {SDK}/0.5.212", result.stderr)

    def test_zipped_templates_are_read(self) -> None:
        make_packages(self.nupkgs)
        make_zipped_template_vsix(self.vsix, f"{SDK}/0.5.212")
        self.assertEqual(self.verify("v0.5.212").returncode, 0)
        make_zipped_template_vsix(self.vsix, f"{SDK}/0.3.159")
        self.assertIn("GSharpConsole.zip!GSharpConsole.gsproj pins", self.verify("v0.5.212").stderr)

    def test_vsix_without_templates_fails(self) -> None:
        make_packages(self.nupkgs)
        make_vsix(self.vsix)
        write_zip(self.vsix / "GSharp.VisualStudio.vsix", {"extension.vsixmanifest": vsix_manifest("0.5.212.9261")})
        self.assertIn("has no project template", self.verify("v0.5.212").stderr)

    def test_missing_vsix_fails(self) -> None:
        make_packages(self.nupkgs)
        self.vsix.mkdir()
        self.assertIn("cannot read", self.verify("v0.5.212").stderr)

    def test_tag_and_vsix_are_required_without_nuget_only(self) -> None:
        make_packages(self.nupkgs)
        self.assertEqual(run("verify", "--nupkgs", str(self.nupkgs)).returncode, 2)


class NugetPushTests(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        self.root = Path(self.workspace.name)
        self.nupkgs = self.root / "nupkgs"
        make_packages(self.nupkgs)
        self.log = self.root / "calls.log"
        self.dotnet = self.root / "dotnet"
        # Logs "<file> <all arguments>", prints a 409 for FAKE_CONFLICT files (exit 0, as --skip-duplicate does),
        # and fails FAKE_FAIL files FAKE_FAIL_TIMES times.
        self.dotnet.write_text(
            '#!/bin/sh\n'
            'file=$(basename "$3")\n'
            'echo "$file $*" >> "$FAKE_LOG"\n'
            'count=$(grep -c "^$file " "$FAKE_LOG")\n'
            'if [ "$file" = "$FAKE_FAIL" ] && [ "$count" -le "${FAKE_FAIL_TIMES:-99}" ]; then exit 1; fi\n'
            'if [ "$file" = "$FAKE_CONFLICT" ]; then echo "Conflict: already exists"; fi\n'
            'exit 0\n')
        self.dotnet.chmod(self.dotnet.stat().st_mode | stat.S_IXUSR)

    def push(self, group: str, **env: str) -> subprocess.CompletedProcess:
        return run("nuget-push", "--group", group, "--nupkgs", str(self.nupkgs), "--dotnet", str(self.dotnet),
                   "--pause", "0", env={"FAKE_LOG": str(self.log), "NUGET_API_KEY": "secret", **env})

    def calls(self) -> list[str]:
        return [line.split()[0] for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_compiler_group_pushes_the_six_rid_packages_in_order_and_nothing_else(self) -> None:
        self.assertEqual(self.push("compiler").returncode, 0)
        self.assertEqual(self.calls(), [f"Gsharp.NET.Sdk.Compiler.{rid}.0.5.212.nupkg" for rid in RIDS])

    def test_sdk_group_pushes_the_sdk_first_then_the_tools_with_their_symbols(self) -> None:
        self.assertEqual(self.push("sdk").returncode, 0)
        self.assertEqual(self.calls(), [
            "Gsharp.NET.Sdk.0.5.212.nupkg", "Gsharp.NET.Sdk.0.5.212.snupkg",
            "Gsharp.Templates.0.5.212.nupkg",
            "Gsharp.Repl.0.5.212.nupkg", "Gsharp.Repl.0.5.212.snupkg",
            "Gsharp.Gsfmt.0.5.212.nupkg", "Gsharp.Gsfmt.0.5.212.snupkg",
            "Gsharp.Cs2Gs.0.5.212.nupkg", "Gsharp.Cs2Gs.0.5.212.snupkg",
            "GSharp.CodeAnalysis.Analyzers.Testing.0.5.212.nupkg", "GSharp.CodeAnalysis.Analyzers.Testing.0.5.212.snupkg"])

    def test_every_push_skips_duplicates_with_the_source_and_key(self) -> None:
        self.assertEqual(self.push("sdk").returncode, 0)
        lines = self.log.read_text().splitlines()
        self.assertTrue(lines)
        for line in lines:
            self.assertIn("nuget push", line)
            self.assertIn("--api-key secret --source https://api.nuget.org/v3/index.json --skip-duplicate", line)

    def test_symbol_package_is_pushed_when_the_primary_package_already_exists(self) -> None:
        result = self.push("sdk", FAKE_CONFLICT="Gsharp.Repl.0.5.212.nupkg")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Gsharp.Repl.0.5.212.snupkg", self.calls())

    def test_a_failed_push_is_retried(self) -> None:
        result = self.push("compiler", FAKE_FAIL="Gsharp.NET.Sdk.Compiler.win-x64.0.5.212.nupkg", FAKE_FAIL_TIMES="2")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls().count("Gsharp.NET.Sdk.Compiler.win-x64.0.5.212.nupkg"), 3)

    def test_the_remaining_group_is_retried_too(self) -> None:
        result = self.push("sdk", FAKE_FAIL="Gsharp.Cs2Gs.0.5.212.snupkg", FAKE_FAIL_TIMES="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls().count("Gsharp.Cs2Gs.0.5.212.snupkg"), 2)

    def test_three_failures_stop_the_group(self) -> None:
        result = self.push("compiler", FAKE_FAIL="Gsharp.NET.Sdk.Compiler.win-x64.0.5.212.nupkg")
        self.assertEqual(result.returncode, 1)
        self.assertIn("failed 3 times", result.stderr)
        self.assertEqual(self.calls()[-1], "Gsharp.NET.Sdk.Compiler.win-x64.0.5.212.nupkg")
        self.assertNotIn("Gsharp.NET.Sdk.Compiler.win-arm64.0.5.212.nupkg", self.calls())

    def test_five_rid_packages_push_nothing(self) -> None:
        (self.nupkgs / "Gsharp.NET.Sdk.Compiler.osx-x64.0.5.212.nupkg").unlink()
        result = self.push("compiler")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_nonpositive_attempts_are_rejected(self) -> None:
        for attempts in ("0", "-1"):
            with self.subTest(attempts=attempts):
                result = run("nuget-push", "--group", "sdk", "--nupkgs", str(self.nupkgs), "--dotnet", str(self.dotnet),
                             "--attempts", attempts, env={"FAKE_LOG": str(self.log), "NUGET_API_KEY": "secret"})
                self.assertEqual(result.returncode, 2)
                self.assertEqual(self.calls(), [])

    def test_missing_api_key_pushes_nothing(self) -> None:
        result = run("nuget-push", "--group", "sdk", "--nupkgs", str(self.nupkgs), "--dotnet", str(self.dotnet),
                     env={"FAKE_LOG": str(self.log), "NUGET_API_KEY": ""})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.calls(), [])


class Marketplace(http.server.BaseHTTPRequestHandler):
    versions: list[dict] = []
    requests: list[dict] = []

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Marketplace.requests.append(body)
        reply = {"results": [{"extensions": [{"versions": Marketplace.versions}] if Marketplace.versions else []}]}
        data = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args) -> None:
        pass


class Feed(http.server.BaseHTTPRequestHandler):
    """A flat container: 200 for ids in `have`, 404 otherwise."""
    have: set[str] = set()

    def do_GET(self) -> None:
        package = self.path.strip("/").split("/")[0]
        self.send_response(200 if package in Feed.have else 404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args) -> None:
        pass


class NotesTests(unittest.TestCase):
    def load(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("release_publish", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_notes_name_unverified_platforms_and_the_visual_studio_omission(self) -> None:
        rp = self.load()
        self.assertEqual(rp.notes_lines([], False), [])
        one = rp.notes_lines(["osx-x64"], False)
        self.assertEqual(len(one), 1)
        self.assertIn("Unverified platform: `osx-x64`.", one[0])
        self.assertIn("Unverified platforms: `osx-x64`, `win-x64`.", rp.notes_lines(["osx-x64", "win-x64"], False)[0])
        both = rp.notes_lines(["osx-x64"], True)
        self.assertEqual(len(both), 2)
        self.assertIn("Not published to the Visual Studio Marketplace", both[1])

    def test_replace_notes_is_idempotent_and_keeps_the_rest(self) -> None:
        rp = self.load()
        body = "## Changes\n\n* one\n"
        once = rp.replace_notes(body, ["A"])
        self.assertEqual(once, "## Changes\n\n* one\n\n<!-- publish-notes -->\nA\n<!-- /publish-notes -->\n")
        self.assertEqual(rp.replace_notes(once, ["A"]), once)
        self.assertEqual(rp.replace_notes(once, ["B", "C"]).count("<!-- publish-notes -->"), 1)
        self.assertIn("B\nC", rp.replace_notes(once, ["B", "C"]))
        self.assertEqual(rp.replace_notes(once, []), "## Changes\n\n* one\n")
        self.assertEqual(rp.replace_notes("", []), "")
        self.assertEqual(rp.replace_notes("", ["A"]), "<!-- publish-notes -->\nA\n<!-- /publish-notes -->\n")

    def test_replace_notes_keeps_text_after_the_section(self) -> None:
        rp = self.load()
        body = "top\n\n<!-- publish-notes -->\nold\n<!-- /publish-notes -->\n\nbottom\n"
        self.assertEqual(rp.replace_notes(body, []), "top\n\nbottom\n")
        prose = "First paragraph.\n\n<!-- publish-notes -->\nold\n<!-- /publish-notes -->\n\nSecond paragraph.\n"
        self.assertEqual(rp.replace_notes(prose, []), "First paragraph.\n\nSecond paragraph.\n")
        self.assertIn("First paragraph.\n\nSecond paragraph.", rp.replace_notes(prose, ["new"]))
        code = "intro\n\n<!-- publish-notes -->\nold\n<!-- /publish-notes -->\n\n    indented code\n"
        self.assertEqual(rp.replace_notes(code, []), "intro\n\n    indented code\n")
        self.assertIn("bottom", rp.replace_notes(body, ["new"]))
        self.assertNotIn("old", rp.replace_notes(body, ["new"]))


class FinalizeTests(unittest.TestCase):
    VERSION = "0.5.300"

    def setUp(self) -> None:
        self.workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        self.root = Path(self.workspace.name)
        self.feed = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Feed)
        self.market = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Marketplace)
        for server in (self.feed, self.market):
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
        ids = [f"Gsharp.NET.Sdk.Compiler.{r}" for r in RIDS] + list(OTHERS)
        Feed.have = {i.lower() for i in ids}
        # The fake serves one list for both extensions: the VS Code and the Visual Studio version.
        Marketplace.versions = [{"version": self.VERSION, "properties": []},
                                {"version": "0.5.300.9261", "properties": []}]
        self.assets = [f"Gsharp.NET.Sdk.Compiler.{r}.{self.VERSION}.nupkg" for r in RIDS]
        self.assets += [f"{o}.{self.VERSION}.nupkg" for o in OTHERS]
        self.assets += [f"{o}.{self.VERSION}.snupkg" for o in OTHERS if o != "Gsharp.Templates"]
        self.assets += ["vscode-gsharp.vsix", "GSharp.VisualStudio.vsix"]
        self.body = "## Changes\n"
        self.log = self.root / "gh.log"
        self.gh = self.root / "gh"
        self.gh.write_text(
            '#!/bin/sh\n'
            'echo "$*" >> "$FAKE_LOG"\n'
            'if [ "$2" = view ]; then cat "$FAKE_VIEW"; exit 0; fi\n'
            'if [ "$2" = edit ]; then\n'
            '  while [ $# -gt 0 ]; do [ "$1" = --notes-file ] && cp "$2" "$FAKE_NOTES_COPY"; shift; done\n'
            '  exit "${FAKE_EDIT_EXIT:-0}"\n'
            'fi\n')
        self.gh.chmod(self.gh.stat().st_mode | stat.S_IXUSR)
        self.write_view()

    def write_view(self) -> None:
        (self.root / "view.json").write_text(json.dumps(
            {"body": self.body, "assets": [{"name": n} for n in self.assets]}))

    def finalize(self, prerelease: str = "false", unverified: str = "", vs: str = "success", vscode: str = "success",
                 release: str = "success", edit_exit: str = "0") -> subprocess.CompletedProcess:
        return run("finalize", "--tag", "v0.5.300", "--repo", "o/r", "--version", self.VERSION,
                   "--prerelease", prerelease, "--vscode-version", self.VERSION,
                   "--visual-studio-version", "0.5.300.9261", "--unverified", unverified,
                   "--github-release", release, "--vscode", vscode, "--visual-studio", vs,
                   "--notes-file", str(self.root / "notes.md"), "--gh", str(self.gh),
                   "--feed-url", f"http://127.0.0.1:{self.feed.server_address[1]}/",
                   "--marketplace-url", f"http://127.0.0.1:{self.market.server_address[1]}/",
                   env={"FAKE_LOG": str(self.log), "FAKE_VIEW": str(self.root / "view.json"),
                        "FAKE_NOTES_COPY": str(self.root / "notes.copy"), "FAKE_EDIT_EXIT": edit_exit})

    def edits(self) -> list[str]:
        return [l for l in self.log.read_text().splitlines() if " edit " in f" {l} "] if self.log.exists() else []

    def test_everything_present_un_drafts_and_keeps_the_body(self) -> None:
        result = self.finalize()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.edits()), 1)
        self.assertIn("--draft=false", self.edits()[0])
        self.assertEqual((self.root / "notes.copy").read_text(), "## Changes\n")

    def test_unverified_platform_is_written_before_the_un_draft(self) -> None:
        self.assertEqual(self.finalize(unverified="osx-x64").returncode, 0)
        self.assertIn("Unverified platform: `osx-x64`.", (self.root / "notes.copy").read_text())

    def test_a_previously_named_platform_is_removed_after_a_good_run(self) -> None:
        self.body = "## Changes\n\n<!-- publish-notes -->\nUnverified platform: `osx-x64`.\n<!-- /publish-notes -->\n"
        self.write_view()
        self.assertEqual(self.finalize().returncode, 0)
        self.assertEqual((self.root / "notes.copy").read_text(), "## Changes\n")

    def test_prerelease_accepts_a_skipped_visual_studio_job_and_names_the_omission(self) -> None:
        Marketplace.versions = [{"version": self.VERSION, "properties": [
            {"key": "Microsoft.VisualStudio.Code.PreRelease", "value": "true"}]}]
        result = self.finalize(prerelease="true", vs="skipped")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Not published to the Visual Studio Marketplace", (self.root / "notes.copy").read_text())

    def test_release_tag_does_not_accept_a_skipped_visual_studio_job(self) -> None:
        for vs in ("skipped", "failure", "cancelled"):
            with self.subTest(vs=vs):
                result = self.finalize(vs=vs)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(self.edits(), [])

    def test_prerelease_does_not_accept_a_failed_visual_studio_job(self) -> None:
        self.assertEqual(self.finalize(prerelease="true", vs="failure").returncode, 1)

    def test_a_skipped_vscode_or_release_job_fails(self) -> None:
        self.assertEqual(self.finalize(vscode="skipped").returncode, 1)
        self.assertEqual(self.finalize(release="skipped").returncode, 1)
        self.assertEqual(self.edits(), [])

    def test_a_missing_nuget_package_blocks_and_is_named(self) -> None:
        Feed.have.discard("gsharp.net.sdk.compiler.osx-x64")
        result = self.finalize()
        self.assertEqual(result.returncode, 1)
        self.assertIn("Gsharp.NET.Sdk.Compiler.osx-x64", result.stdout)
        self.assertEqual(self.edits(), [])

    def test_a_missing_extension_version_blocks(self) -> None:
        Marketplace.versions = [{"version": "0.5.299", "properties": []}]
        result = self.finalize()
        self.assertEqual(result.returncode, 1)
        self.assertIn("VS Code Marketplace", result.stderr)

    def test_a_marketplace_pre_release_flag_that_differs_blocks(self) -> None:
        self.assertEqual(self.finalize(prerelease="true", vs="skipped").returncode, 1)

    def test_a_missing_release_asset_blocks_and_is_named(self) -> None:
        self.assets.remove("Gsharp.Repl.0.5.300.snupkg")
        self.write_view()
        result = self.finalize()
        self.assertEqual(result.returncode, 1)
        self.assertIn("Gsharp.Repl.0.5.300.snupkg", result.stdout)
        self.assertEqual(self.edits(), [])

    def test_a_failed_un_draft_fails_the_job(self) -> None:
        self.assertEqual(self.finalize(edit_exit="1").returncode, 1)

    def test_verify_writes_the_extension_versions(self) -> None:
        make_packages(self.root / "n", version=self.VERSION)
        make_vsix(self.root / "v", code_version=self.VERSION, studio_version="0.5.300.9261", pin=f"{SDK}/{self.VERSION}")
        out = self.root / "out.txt"
        result = run("verify", "--nupkgs", str(self.root / "n"), "--vsix", str(self.root / "v"), "--tag", "v0.5.300",
                     env={"GITHUB_OUTPUT": str(out)})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(out.read_text(), "version=0.5.300\nprerelease=false\nvscode_version=0.5.300\n"
                                          "visual_studio_version=0.5.300.9261\n")


class MarketplaceVersionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Marketplace)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        Marketplace.requests = []
        Marketplace.versions = [
            {"version": "0.5.212", "properties": []},
            {"version": "0.5.300", "properties": [{"key": "Microsoft.VisualStudio.Code.PreRelease", "value": "true"}]},
        ]

    def ask(self, version: str, kind: str = "any") -> subprocess.CompletedProcess:
        return run("marketplace-version", "gsharplang.vscode-gsharp", "--version", version, "--kind", kind,
                   "--url", f"http://127.0.0.1:{self.server.server_address[1]}/")

    def test_published_release(self) -> None:
        result = self.ask("0.5.212", "release")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("is published", result.stdout)
        self.assertEqual(Marketplace.requests[0]["filters"][0]["criteria"][0]["value"], "gsharplang.vscode-gsharp")

    def test_published_prerelease(self) -> None:
        self.assertEqual(self.ask("0.5.300", "prerelease").returncode, 0)

    def test_absent_version(self) -> None:
        result = self.ask("0.5.213", "release")
        self.assertEqual(result.returncode, 1)
        self.assertIn("is not published", result.stdout)

    def test_unknown_extension(self) -> None:
        Marketplace.versions = []
        self.assertEqual(self.ask("0.5.212").returncode, 1)

    def test_present_with_the_other_flag_is_a_collision(self) -> None:
        for version, kind in (("0.5.212", "prerelease"), ("0.5.300", "release")):
            with self.subTest(version=version, kind=kind):
                result = self.ask(version, kind)
                self.assertEqual(result.returncode, 3)
                self.assertIn("this run publishes a", result.stderr)

    def test_unreachable_marketplace_is_absent(self) -> None:
        result = run("marketplace-version", "x.y", "--version", "1.0.0", "--url", "http://127.0.0.1:9/")
        self.assertEqual(result.returncode, 1)
        self.assertIn("warning", result.stderr)


if __name__ == "__main__":
    unittest.main()
