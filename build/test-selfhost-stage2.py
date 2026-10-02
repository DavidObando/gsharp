#!/usr/bin/env python3
"""Regression tests for build/selfhost-stage2.py (issue #4631, C3).

The comparison tests hash real assemblies from the Release build with
build/selfhost/PeContentHash.cs, so they need `dotnet` and a built tree;
CI runs them after the solution build.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("selfhost_stage2", REPO / "build" / "selfhost-stage2.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/selfhost-stage2.py")
stage2 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stage2)

CORE = REPO / "out" / "bin" / "Release" / "Core" / "GSharp.Core.dll"
FORMATTING = REPO / "out" / "bin" / "Release" / "GSharp.Formatting" / "GSharp.Formatting.dll"


def mvid_offset(image: bytes) -> int:
    """File offset of the MVID: the first GUID of the #GUID metadata heap."""
    root = image.find(b"BSJB")
    if root < 0:
        raise AssertionError("no metadata root")
    version_length = struct.unpack_from("<I", image, root + 12)[0]
    cursor = root + 16 + version_length + 2
    streams = struct.unpack_from("<H", image, cursor)[0]
    cursor += 2
    for _ in range(streams):
        offset, _size = struct.unpack_from("<II", image, cursor)
        cursor += 8
        end = image.index(b"\0", cursor)
        name = image[cursor:end].decode("ascii")
        cursor = (end + 4) & ~3
        if name == "#GUID":
            return root + offset
    raise AssertionError("no #GUID heap")


def stage(assembly: Path) -> dict:
    return {"assemblies": {"a.dll": str(assembly)}}


class DecideTests(unittest.TestCase):
    def test_no_comparison_is_not_equivalence(self) -> None:
        self.assertEqual((False, True), stage2.decide({"comparison": [], "tests": []}))

    def test_a_failed_test_run_is_reported(self) -> None:
        report = {"comparison": [{"contentEqual": True}], "tests": [{"exitCode": 0}, {"exitCode": 1}]}
        self.assertEqual((True, False), stage2.decide(report))


HAVE_BUILD = CORE.exists() and FORMATTING.exists() and shutil.which("dotnet") is not None
if os.environ.get("CI") and not HAVE_BUILD:
    # In CI these run after the Release build; a skip there would be vacuous.
    raise RuntimeError("CI run without a Release build: build GSharp.sln before this script")


@unittest.skipUnless(HAVE_BUILD, "needs a Release build and dotnet")
class CompareTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.work = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_the_same_assembly_is_equal(self) -> None:
        copy = self.work / "copy.dll"
        shutil.copy2(CORE, copy)
        row = stage2.compare(stage(CORE), stage(copy), self.work)[0]
        self.assertTrue(row["contentEqual"])
        self.assertTrue(row["bytesEqual"])
        self.assertGreater(row["stage1"]["methods"], 1000)

    def test_a_different_assembly_is_not_equal(self) -> None:
        # The deliberately broken input: stage 2 produced different code.
        row = stage2.compare(stage(CORE), stage(FORMATTING), self.work)[0]
        self.assertFalse(row["contentEqual"])
        self.assertFalse(stage2.decide({"comparison": [row], "tests": []})[0])

    def test_a_one_byte_il_change_is_not_equal(self) -> None:
        offset = subprocess.run(
            ["dotnet", "run", str(stage2.HASH_TOOL), "--", "--il-offset", str(CORE)],
            cwd=stage2.HASH_TOOL.parent, capture_output=True, text=True, check=True).stdout.strip()
        image = bytearray(CORE.read_bytes())
        image[int(offset)] ^= 0x01
        patched = self.work / "il.dll"
        patched.write_bytes(bytes(image))
        row = stage2.compare(stage(CORE), stage(patched), self.work)[0]
        self.assertFalse(row["contentEqual"], "IL bytes must be part of the hash")

    def test_only_the_mvid_differing_is_equal_content(self) -> None:
        image = bytearray(CORE.read_bytes())
        at = mvid_offset(bytes(image))
        image[at:at + 16] = bytes(255 - b for b in image[at:at + 16])
        patched = self.work / "patched.dll"
        patched.write_bytes(bytes(image))
        row = stage2.compare(stage(CORE), stage(patched), self.work)[0]
        self.assertFalse(row["bytesEqual"])
        self.assertTrue(row["contentEqual"], "the MVID must be zeroed before hashing")


if __name__ == "__main__":
    unittest.main()
