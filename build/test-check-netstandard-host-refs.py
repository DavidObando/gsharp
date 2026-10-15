#!/usr/bin/env python3
"""Regression tests for build/check-netstandard-host-refs.py (ADR-0154).

The tests synthesize minimal managed PE images (a CLI header and a metadata
root holding only the #~ AssemblyRef table and a #Strings heap, which is all the check reads), so they need
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


def make_pe(refs: list[str], tail_shared: bool = False) -> bytes:
    """A PE32 with one section holding a CLI header and a metadata root with #~ and #Strings.

    The #~ stream has one AssemblyRef row per name in [`refs`]. With `tail_shared` each name
    is stored only as the tail of a longer heap string ("Probe." + name), as a linker that
    merges string suffixes does, and the row's index points into the middle of it.
    """
    heap = bytearray(b"\0")
    indices = []
    for name in refs:
        stored = ("Probe." + name) if tail_shared else name
        indices.append(len(heap) + (len("Probe.") if tail_shared else 0))
        heap += stored.encode() + b"\0"
    heap += b"\0" * (-len(heap) % 4)
    tables = struct.pack("<IBBBBQQ", 0, 2, 0, 0, 1, 1 << 0x23, 0) + struct.pack("<I", len(refs))
    for index in indices:
        # MajorVersion..RevisionNumber, Flags, PublicKeyOrToken, Name, Culture, HashValue (2-byte heap indices).
        tables += struct.pack("<HHHHIHHHH", 2, 0, 0, 0, 0, 0, index, 0, 0)
    tables += b"\0" * (-len(tables) % 4)
    version = b"v4.0.30319\0\0"
    names = [(b"#~\0\0", tables), (b"#Strings\0\0\0\0", bytes(heap))]
    root_size = 16 + len(version) + 4 + sum(8 + len(n) for n, _ in names)
    metadata = struct.pack("<IHHII", 0x424A5342, 1, 1, 0, len(version)) + version
    metadata += struct.pack("<HH", 0, len(names))
    offset = root_size
    payload = b""
    for stream_name, content in names:
        metadata += struct.pack("<II", offset, len(content)) + stream_name
        payload += content
        offset += len(content)
    metadata += payload
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


GOOD = make_pe(["netstandard", "Microsoft.Build.Utilities.Core"])
BAD = make_pe(["netstandard", "System.Private.CoreLib"])
BAD_TAIL_SHARED = make_pe(["netstandard", "System.Private.CoreLib"], tail_shared=True)


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

    def test_assembly_ref_sharing_a_heap_string_tail_is_found(self) -> None:
        code, out = run(str(self.write("Tail.dll", BAD_TAIL_SHARED)))
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
