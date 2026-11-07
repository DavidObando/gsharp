#!/usr/bin/env python3
"""Unit tests for build/selfhost-fixpoint.py (issue #4925, ADR-0154)."""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

BUILD = Path(__file__).resolve().parent
sys.path.insert(0, str(BUILD))

import selfhost_pe as pe  # noqa: E402


def _load_fixpoint():
    spec = importlib.util.spec_from_file_location("selfhost_fixpoint", BUILD / "selfhost-fixpoint.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixpoint = _load_fixpoint()


def _build_sample_pe(work_dir: Path) -> Path:
    proj = work_dir / "sample"
    proj.mkdir(parents=True, exist_ok=True)
    (proj / "Sample.csproj").write_text(
        """<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Deterministic>true</Deterministic>
  </PropertyGroup>
</Project>
""",
        encoding="utf-8",
    )
    (proj / "Sample.cs").write_text(
        "namespace Sample { public static class P { public static int V() => 42; } }\n",
        encoding="utf-8",
    )
    subprocess.run(
        [
            "dotnet", "build", "Sample.csproj", "-c", "Release", "--nologo", "-v", "quiet",
            "-p:ImportDirectoryBuildProps=false", "-p:ImportDirectoryBuildTargets=false",
        ],
        cwd=proj,
        check=True,
    )
    return proj / "bin" / "Release" / "net10.0" / "Sample.dll"


class SelfhostFixpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        base_dir = Path.home() / ".cache" / "gsharp-fixpoint-tests"
        base_dir.mkdir(parents=True, exist_ok=True)
        cls.class_dir = Path(tempfile.mkdtemp(prefix="fixture-", dir=base_dir))
        cls.sample_pe = _build_sample_pe(cls.class_dir)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.class_dir, ignore_errors=True)

    def setUp(self) -> None:
        self.temp_dir = Path(tempfile.mkdtemp(prefix="case-", dir=self.class_dir))
        self.addCleanup(lambda: shutil.rmtree(self.temp_dir, ignore_errors=True))

    def test_compare_stage_directories_accepts_mvid_only_difference(self) -> None:
        stage2 = self.temp_dir / "stage2"
        stage3 = self.temp_dir / "stage3"
        stage2.mkdir()
        stage3.mkdir()
        raw = bytearray(self.sample_pe.read_bytes())
        layout = pe.inspect_layout(bytes(raw))
        mutated = bytearray(raw)
        mutated[layout.mvid_offset] ^= 0xFF

        for _, dll in fixpoint.ASSEMBLIES:
            (stage2 / dll).write_bytes(raw)
            (stage3 / dll).write_bytes(mutated)

        results = fixpoint.compare_stage_directories(stage2, stage3)
        self.assertEqual(len(results), 2)
        self.assertTrue(all(r["equal"] for r in results))
        self.assertNotEqual(results[0]["stage2_raw_sha256"], results[0]["stage3_raw_sha256"])
        self.assertEqual(results[0]["stage2_normalized_sha256"], results[0]["stage3_normalized_sha256"])

    def test_compare_stage_directories_rejects_non_mvid_difference(self) -> None:
        stage2 = self.temp_dir / "stage2"
        stage3 = self.temp_dir / "stage3"
        stage2.mkdir()
        stage3.mkdir()
        raw = bytearray(self.sample_pe.read_bytes())
        mutated = bytearray(raw)
        mutated[0x40] ^= 0x01

        for _, dll in fixpoint.ASSEMBLIES:
            (stage2 / dll).write_bytes(raw)
            (stage3 / dll).write_bytes(mutated if dll == "gsc.dll" else raw)

        with self.assertRaises(fixpoint.FixpointError) as ctx:
            fixpoint.compare_stage_directories(stage2, stage3)
        self.assertIn("gsc.dll", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
