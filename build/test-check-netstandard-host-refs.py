#!/usr/bin/env python3
"""Regression tests for build/check-netstandard-host-refs.py (ADR-0154).

The tests synthesize minimal managed PE images (a CLI header and a metadata
root holding only a #Strings heap, which is all the check reads), so they need
no build output. The "bad" image is the #4921 shape: an assembly that names
System.Private.CoreLib. The check must fail on it and pass on the good image.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import struct
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("check_host_refs", REPO / "build" / "check-netstandard-host-refs.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/check-netstandard-host-refs.py")
check = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = check
SPEC.loader.exec_module(check)


def make_pe(names: list[str]) -> bytes:
    """A PE32 with one section holding a CLI header and a #Strings-only metadata root."""
    heap = b"\0" + b"".join(n.encode() + b"\0" for n in names)
    heap += b"\0" * (-len(heap) % 4)
    version = b"v4.0.30319\0\0"
    stream_name = b"#Strings\0\0\0\0"
    root_size = 16 + len(version) + 4 + 8 + len(stream_name)
    metadata = struct.pack("<IHHII", 0x424A5342, 1, 1, 0, len(version)) + version
    metadata += struct.pack("<HH", 0, 1) + struct.pack("<II", root_size, len(heap)) + stream_name + heap
    section_rva, raw_ptr = 0x2000, 0x200
    cli = bytearray(72)
    struct.pack_into("<I", cli, 0, 72)
    struct.pack_into("<II", cli, 8, section_rva + 72, len(metadata))
    body = bytes(cli) + metadata
    optional = bytearray(224)
    struct.pack_into("<H", optional, 0, 0x10B)
    struct.pack_into("<I", optional, 92, 16)  # NumberOfRvaAndSizes
    struct.pack_into("<II", optional, 96 + 14 * 8, section_rva, 72)
    coff = struct.pack("<HHIIIHH", 0x14C, 1, 0, 0, 0, len(optional), 0x2000)
    section = b".text\0\0\0" + struct.pack("<IIII", len(body), section_rva, len(body), raw_ptr) + b"\0" * 16
    header = bytearray(0x80) + b"PE\0\0" + coff + bytes(optional) + section
    struct.pack_into("<I", header, 0x3C, 0x80)
    header[0:2] = b"MZ"
    return bytes(header) + b"\0" * (raw_ptr - len(header)) + body


GOOD = make_pe(["netstandard", "Microsoft.Build.Utilities.Core", "NullableAttribute"])
BAD = make_pe(["netstandard", "System.Private.CoreLib", "NullableAttribute"])


def run(*args: str) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = check.main(list(args))
    return code, out.getvalue()


class HostReferenceCheckTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def write(self, name: str, data: bytes) -> Path:
        path = self.dir / name
        path.write_bytes(data)
        return path

    def nupkg(self, name: str, entries: dict[str, bytes]) -> Path:
        path = self.dir / name
        with zipfile.ZipFile(path, "w") as package:
            for entry, data in entries.items():
                package.writestr(entry, data)
        return path

    def test_clean_dll_passes(self) -> None:
        code, out = run(str(self.write("Good.dll", GOOD)))
        self.assertEqual(code, 0, out)

    def test_dll_naming_system_private_corelib_fails(self) -> None:
        code, out = run(str(self.write("Bad.dll", BAD)))
        self.assertEqual(code, 1)
        self.assertIn("System.Private.CoreLib", out)

    def test_task_dll_inside_nupkg_is_checked(self) -> None:
        good = self.nupkg("Good.nupkg", {"tools/task/Gsharp.NET.Sdk.dll": GOOD})
        bad = self.nupkg("Bad.nupkg", {"tools/task/Gsharp.NET.Sdk.dll": BAD})
        self.assertEqual(run(str(good))[0], 0)
        code, out = run(str(bad))
        self.assertEqual(code, 1)
        self.assertIn("Bad.nupkg!tools/task/Gsharp.NET.Sdk.dll", out)

    def test_netstandard_lib_dll_inside_nupkg_is_checked(self) -> None:
        bad = self.nupkg("Lib.nupkg", {"lib/netstandard2.0/Lib.dll": BAD})
        self.assertEqual(run(str(bad))[0], 1)

    def test_modern_tfm_dll_is_not_in_scope(self) -> None:
        # net10.0 assemblies legitimately target System.Private.CoreLib hosts.
        package = self.nupkg("Modern.nupkg", {"lib/net10.0/Lib.dll": BAD, "tools/task/T.dll": GOOD})
        self.assertEqual(run(str(package))[0], 0)

    def test_package_without_in_scope_assemblies_fails_closed(self) -> None:
        package = self.nupkg("Empty.nupkg", {"lib/net10.0/Lib.dll": GOOD})
        self.assertEqual(run(str(package))[0], 2)

    def test_missing_file_fails(self) -> None:
        self.assertEqual(run(str(self.dir / "nope.dll"))[0], 1)

    def test_non_managed_file_fails(self) -> None:
        code, out = run(str(self.write("Junk.dll", b"not a pe")))
        self.assertEqual(code, 1)
        self.assertIn("cannot read metadata", out)


if __name__ == "__main__":
    unittest.main()
