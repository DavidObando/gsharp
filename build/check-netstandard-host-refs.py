#!/usr/bin/env python3
"""Fail when a netstandard2.0 / .NET Framework assembly names a host runtime assembly.

Issue #4921: gsc once scoped `NullableAttribute` TypeRefs of the packed MSBuild
task assembly (`tools/task/Gsharp.NET.Sdk.dll`, netstandard2.0) at the build
host's `System.Private.CoreLib`. That assembly does not exist on .NET
Framework, so Visual Studio's MSBuild could not load the task. Any
`System.Private.*` implementation assembly in a netstandard2.0 / net4x output
is the same defect, whatever type triggered it.

Checked inputs (fail closed: a missing or empty set is an error, never a pass):
  * a `.dll` path is checked directly;
  * a `.nupkg` is opened and every `tools/task/*.dll` plus every
    `lib/netstandard*/*.dll` and `lib/net4*/*.dll` entry is checked.
With no arguments every `Gsharp*.nupkg` in out/bin/Release/nupkgs is checked.

Method: the names of AssemblyRef rows live in the metadata `#Strings` heap.
Reading that heap and testing each NUL-terminated string is enough, because
only metadata entity names are stored there and no legitimate entity is named
`System.Private.*` in these outputs. (User string literals live in `#US`, as
UTF-16, and are not looked at.)

Usage: check-netstandard-host-refs.py [PATH ...]
Exit status 0 when clean, 1 with one line per finding, 2 when nothing was checked.
"""

from __future__ import annotations

import fnmatch
import struct
import sys
import zipfile
from pathlib import Path

BANNED_PREFIX = "System.Private."
DEFAULT_GLOB = "out/bin/Release/nupkgs/Gsharp*.nupkg"
PACKAGE_ENTRY_PATTERNS = ("tools/task/*.dll", "lib/netstandard*/*.dll", "lib/net4*/*.dll")


class MetadataError(ValueError):
    pass


def strings_heap(data: bytes) -> bytes:
    """Return the #Strings heap of a managed PE image."""
    if data[:2] != b"MZ":
        raise MetadataError("not a PE image")
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe : pe + 4] != b"PE\0\0":
        raise MetadataError("bad PE signature")
    sections_count = struct.unpack_from("<H", data, pe + 6)[0]
    optional_size = struct.unpack_from("<H", data, pe + 20)[0]
    optional = pe + 24
    magic = struct.unpack_from("<H", data, optional)[0]
    dirs = optional + (96 if magic == 0x10B else 112)
    cli_rva = struct.unpack_from("<I", data, dirs + 14 * 8)[0]
    if cli_rva == 0:
        raise MetadataError("no CLI header (not a managed assembly)")
    sections = optional + optional_size

    def to_offset(rva: int) -> int:
        for i in range(sections_count):
            base = sections + i * 40
            vsize, vaddr, rawsize, rawptr = struct.unpack_from("<IIII", data, base + 8)
            if vaddr <= rva < vaddr + max(vsize, rawsize):
                return rawptr + rva - vaddr
        raise MetadataError("RVA outside every section")

    cli = to_offset(cli_rva)
    meta_rva = struct.unpack_from("<I", data, cli + 8)[0]
    meta = to_offset(meta_rva)
    if struct.unpack_from("<I", data, meta)[0] != 0x424A5342:
        raise MetadataError("bad metadata signature")
    version_len = struct.unpack_from("<I", data, meta + 12)[0]
    pos = meta + 16 + version_len + 2
    streams = struct.unpack_from("<H", data, pos)[0]
    pos += 2
    for _ in range(streams):
        offset, size = struct.unpack_from("<II", data, pos)
        pos += 8
        end = data.index(b"\0", pos)
        name = data[pos:end].decode("ascii")
        pos = (end + 4) & ~3
        if name == "#Strings":
            return data[meta + offset : meta + offset + size]
    raise MetadataError("no #Strings heap")


def host_references(data: bytes) -> list[str]:
    heap = strings_heap(data)
    return sorted({s.decode("utf-8", "replace") for s in heap.split(b"\0") if s.startswith(BANNED_PREFIX.encode())})


def check_image(label: str, data: bytes) -> list[str]:
    try:
        names = host_references(data)
    except (MetadataError, struct.error, ValueError) as error:
        return [f"{label}: cannot read metadata ({error})"]
    return [f"{label}: references host assembly '{name}' (issue #4921)" for name in names]


def check_path(path: Path) -> tuple[int, list[str]]:
    """Returns (assemblies checked, findings)."""
    if path.suffix == ".nupkg":
        checked = 0
        findings: list[str] = []
        with zipfile.ZipFile(path) as package:
            for entry in sorted(package.namelist()):
                if any(fnmatch.fnmatchcase(entry, p) for p in PACKAGE_ENTRY_PATTERNS):
                    checked += 1
                    findings += check_image(f"{path.name}!{entry}", package.read(entry))
        return checked, findings
    return 1, check_image(str(path), path.read_bytes())


def main(argv: list[str]) -> int:
    paths = [Path(a) for a in argv] or sorted(Path(".").glob(DEFAULT_GLOB))
    total = 0
    findings: list[str] = []
    for path in paths:
        if not path.is_file():
            findings.append(f"{path}: no such file")
            continue
        checked, found = check_path(path)
        total += checked
        findings += found
    for line in findings:
        print(line)
    if total == 0:
        print("no netstandard2.0 / net4x assembly was found to check; refusing to pass vacuously")
        return 1 if findings else 2
    if findings:
        return 1
    print(f"ok: {total} assembly(ies) checked, none reference {BANNED_PREFIX}*")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
