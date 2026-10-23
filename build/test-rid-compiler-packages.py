#!/usr/bin/env python3
"""Tests for the ReadyToRun compiler packages (ADR-0207, issue #5155).

- `GsharpAssertImages`, the pack-time invariant in src/Sdk/Gsharp.NET.Sdk.Compiler, runs from the real
  project file against fake PE files that carry only a Machine field.
- build/check-rid-packages.py runs against a local HTTP server that plays the NuGet flat container.
"""

from __future__ import annotations

import http.server
import importlib.util
import os
import struct
import subprocess
import tempfile
import threading
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PROJECT = REPO / "src" / "Sdk" / "Gsharp.NET.Sdk.Compiler" / "Gsharp.NET.Sdk.Compiler.gsproj"
SPEC = importlib.util.spec_from_file_location("check_rid_packages", REPO / "build" / "check-rid-packages.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/check-rid-packages.py")
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)

PORTABLE = 0x14C
LINUX_X64_READY_TO_RUN = 0x8664 ^ 0x7B79


def fake_pe(path: Path, machine: int) -> Path:
    """A file with the two fields that the task reads: the PE header offset (0x3C) and the Machine."""
    data = bytearray(0x100)
    struct.pack_into("<I", data, 0x3C, 0x80)
    struct.pack_into("<H", data, 0x80 + 4, machine)
    path.write_bytes(bytes(data))
    return path


class AssertImagesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = tempfile.TemporaryDirectory()
        self.root = Path(self.workspace.name)
        using_task = next(node for node in ET.parse(PROJECT).getroot().iter("UsingTask")
                          if node.get("TaskName") == "GsharpAssertImages")
        self.using_task = ET.tostring(using_task, encoding="unicode")

    def tearDown(self) -> None:
        self.workspace.cleanup()

    def run_task(self, portable: list[Path], ready_to_run: list[Path], packed: list[Path],
                 forbidden: str = "Gsharp.Runtime.Channels.dll;Gsharp.Runtime.Values.dll") -> subprocess.CompletedProcess:
        def group(name: str, paths: list[Path]) -> str:
            return f'<{name} Include="{";".join(str(path) for path in paths)}" />' if paths else ""
        project = self.root / "Check.proj"
        project.write_text(f"""<Project>
  {self.using_task}
  <Target Name="Check">
    <ItemGroup>
      {group("Portable", portable)}
      {group("R2R", ready_to_run)}
      {group("Packed", packed)}
    </ItemGroup>
    <GsharpAssertImages Portable="@(Portable)" ReadyToRun="@(R2R)" ForbiddenNames="{forbidden}" Packed="@(Packed)" />
  </Target>
</Project>""", encoding="utf-8")
        env = dict(os.environ, MSBUILDDISABLENODEREUSE="1", DOTNET_CLI_TELEMETRY_OPTOUT="1")
        return subprocess.run(["dotnet", "msbuild", str(project), "-t:Check", "-nologo", "-v:m"],
                              capture_output=True, text=True, env=env, cwd=self.root)

    def test_good_inputs_pass(self) -> None:
        portable = fake_pe(self.root / "Gsharp.Runtime.Channels.dll", PORTABLE)
        r2r = fake_pe(self.root / "gsc.dll", LINUX_X64_READY_TO_RUN)
        packed = fake_pe(self.root / "GSharp.Core.dll", LINUX_X64_READY_TO_RUN)
        result = self.run_task([portable], [r2r], [packed])
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_a_ready_to_run_runtime_file_fails_the_pack(self) -> None:
        # Mutant: the channels runtime went through crossgen2.
        portable = fake_pe(self.root / "Gsharp.Runtime.Channels.dll", LINUX_X64_READY_TO_RUN)
        result = self.run_task([portable], [], [])
        self.assertNotEqual(0, result.returncode)
        self.assertIn("must be 0x14C", result.stdout + result.stderr)

    def test_a_portable_compiler_image_fails_the_pack(self) -> None:
        # crossgen2 did not run: the package would call IL a ReadyToRun image.
        r2r = fake_pe(self.root / "gsc.dll", PORTABLE)
        result = self.run_task([], [r2r], [])
        self.assertNotEqual(0, result.returncode)
        self.assertIn("crossgen2 did not run", result.stdout + result.stderr)

    def test_a_runtime_file_in_the_package_fails_the_pack(self) -> None:
        packed = fake_pe(self.root / "Gsharp.Runtime.Values.dll", PORTABLE)
        result = self.run_task([], [], [packed])
        self.assertNotEqual(0, result.returncode)
        self.assertIn("portable runtime set", result.stdout + result.stderr)

    def test_the_project_excludes_the_set_from_crossgen_and_from_the_package(self) -> None:
        text = PROJECT.read_text(encoding="utf-8")
        compiler = (REPO / "src" / "Compiler" / "Compiler.gsproj").read_text(encoding="utf-8")
        for name in ("Gsharp.Runtime.Channels.dll", "Gsharp.Runtime.Values.dll",
                     "Gsharp.Extensions.dll", "Gsharp.HotReload.Runtime.dll"):
            self.assertIn(name, text)
            self.assertIn(name, compiler)


class Feed(http.server.BaseHTTPRequestHandler):
    present: set[str] = set()

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        if self.path in Feed.present:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"<package/>")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args) -> None:
        pass


class CheckRidPackagesTests(unittest.TestCase):
    VERSION = "0.5.300-gabcdef1234"

    def setUp(self) -> None:
        self.workspace = tempfile.TemporaryDirectory()
        self.packages = Path(self.workspace.name)
        (self.packages / f"Gsharp.NET.Sdk.{self.VERSION}.nupkg").write_bytes(b"x")
        for rid in checker.RIDS:
            (self.packages / f"Gsharp.NET.Sdk.Compiler.{rid}.{self.VERSION}.nupkg").write_bytes(b"x")
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Feed)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}/flat"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.workspace.cleanup()

    def publish(self, *ids: str) -> None:
        Feed.present = {f"/flat/{i.lower()}/{self.VERSION.lower()}/{i.lower()}.nuspec" for i in ids}

    def run_check(self, *extra: str, wait: float = 0) -> int:
        return checker.main(["--packages", str(self.packages), "--base-url", self.base,
                             "--wait-minutes", str(wait), "--interval", "0", *extra],
                            sleep=lambda _: None)

    def test_all_six_present_passes(self) -> None:
        self.publish(*[f"Gsharp.NET.Sdk.Compiler.{rid}" for rid in checker.RIDS])
        self.assertEqual(0, self.run_check())

    def test_one_missing_rid_package_fails(self) -> None:
        self.publish(*[f"Gsharp.NET.Sdk.Compiler.{rid}" for rid in checker.RIDS if rid != "osx-arm64"])
        self.assertEqual(1, self.run_check())

    def test_the_sdk_package_is_required_only_when_asked(self) -> None:
        self.publish(*[f"Gsharp.NET.Sdk.Compiler.{rid}" for rid in checker.RIDS])
        self.assertEqual(0, self.run_check())
        self.assertEqual(1, self.run_check("--require-sdk"))
        self.publish("Gsharp.NET.Sdk", *[f"Gsharp.NET.Sdk.Compiler.{rid}" for rid in checker.RIDS])
        self.assertEqual(0, self.run_check("--require-sdk"))

    def test_a_build_without_all_six_packages_fails_before_asking_the_feed(self) -> None:
        (self.packages / f"Gsharp.NET.Sdk.Compiler.win-arm64.{self.VERSION}.nupkg").unlink()
        self.publish(*[f"Gsharp.NET.Sdk.Compiler.{rid}" for rid in checker.RIDS])
        self.assertEqual(1, self.run_check())

    def test_waiting_ends_when_the_last_package_appears(self) -> None:
        ids = [f"Gsharp.NET.Sdk.Compiler.{rid}" for rid in checker.RIDS]
        self.publish(*ids[:-1])
        calls = []

        def sleep(_: float) -> None:
            calls.append(1)
            self.publish(*ids)

        code = checker.main(["--packages", str(self.packages), "--base-url", self.base,
                             "--wait-minutes", "5", "--interval", "0"], sleep=sleep)
        self.assertEqual(0, code)
        self.assertEqual(1, len(calls))


if __name__ == "__main__":
    unittest.main()
