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

Method: the AssemblyRef table is read through its heap indices, so the name a
row really points at is tested (a string can share the tail of another string
in the heap, which a scan of the heap alone would miss).

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


# Column kinds for the tables that precede AssemblyRef (ECMA-335 II.22): u1/u2/u4 are
# fixed-width, S/G/B are #Strings/#GUID/#Blob heap indices, ("T", table) is a simple
# table index, ("C", name) a coded index.
CODED = {
    "TypeDefOrRef": (2, (0x02, 0x01, 0x1B)),
    "HasConstant": (2, (0x04, 0x08, 0x17)),
    "HasCustomAttribute": (
        5,
        (0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0A, 0x00, 0x0E, 0x17, 0x14, 0x11, 0x1A, 0x1B, 0x20, 0x23, 0x26, 0x27, 0x28, 0x2A, 0x2C, 0x2B),
    ),
    "CustomAttributeType": (3, (None, None, 0x06, 0x0A, None)),
    "HasFieldMarshal": (1, (0x04, 0x08)),
    "HasDeclSecurity": (2, (0x02, 0x06, 0x20)),
    "MemberRefParent": (3, (0x02, 0x01, 0x1A, 0x06, 0x1B)),
    "HasSemantics": (1, (0x14, 0x17)),
    "MethodDefOrRef": (1, (0x06, 0x0A)),
    "MemberForwarded": (1, (0x04, 0x06)),
    "ResolutionScope": (2, (0x00, 0x1A, 0x23, 0x01)),
}
C = lambda name: ("C", name)  # noqa: E731
T = lambda table: ("T", table)  # noqa: E731
TABLES = {
    0x00: ["u2", "S", "G", "G", "G"],
    0x01: [C("ResolutionScope"), "S", "S"],
    0x02: ["u4", "S", "S", C("TypeDefOrRef"), T(0x04), T(0x06)],
    0x03: [T(0x04)],
    0x04: ["u2", "S", "B"],
    0x05: [T(0x06)],
    0x06: ["u4", "u2", "u2", "S", "B", T(0x08)],
    0x07: [T(0x08)],
    0x08: ["u2", "u2", "S"],
    0x09: [T(0x02), C("TypeDefOrRef")],
    0x0A: [C("MemberRefParent"), "S", "B"],
    0x0B: ["u2", C("HasConstant"), "B"],
    0x0C: [C("HasCustomAttribute"), C("CustomAttributeType"), "B"],
    0x0D: [C("HasFieldMarshal"), "B"],
    0x0E: ["u2", C("HasDeclSecurity"), "B"],
    0x0F: ["u2", "u4", T(0x02)],
    0x10: ["u4", T(0x04)],
    0x11: ["B"],
    0x12: [T(0x02), T(0x14)],
    0x13: [T(0x14)],
    0x14: ["u2", "S", C("TypeDefOrRef")],
    0x15: [T(0x02), T(0x17)],
    0x16: [T(0x17)],
    0x17: ["u2", "S", "B"],
    0x18: ["u2", T(0x06), C("HasSemantics")],
    0x19: [T(0x02), C("MethodDefOrRef"), C("MethodDefOrRef")],
    0x1A: ["S"],
    0x1B: ["B"],
    0x1C: ["u2", C("MemberForwarded"), "S", T(0x1A)],
    0x1D: ["u4", T(0x04)],
    0x1E: ["u4", "u4"],
    0x1F: ["u4"],
    0x20: ["u4", "u2", "u2", "u2", "u2", "u4", "B", "S", "S"],
    0x21: ["u4"],
    0x22: ["u4", "u4", "u4"],
}
ASSEMBLY_REF = 0x23


def assembly_ref_names(data: bytes) -> list[str]:
    """Return the Name of every AssemblyRef row of a managed PE image."""
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
    meta = to_offset(struct.unpack_from("<I", data, cli + 8)[0])
    if struct.unpack_from("<I", data, meta)[0] != 0x424A5342:
        raise MetadataError("bad metadata signature")
    version_len = struct.unpack_from("<I", data, meta + 12)[0]
    pos = meta + 16 + version_len + 2
    streams = struct.unpack_from("<H", data, pos)[0]
    pos += 2
    found: dict[str, tuple[int, int]] = {}
    for _ in range(streams):
        offset, size = struct.unpack_from("<II", data, pos)
        pos += 8
        end = data.index(b"\0", pos)
        found[data[pos:end].decode("ascii")] = (meta + offset, size)
        pos = (end + 4) & ~3
    if "#Strings" not in found:
        raise MetadataError("no #Strings heap")
    table_stream = found.get("#~") or found.get("#-")
    if table_stream is None:
        raise MetadataError("no metadata table stream")
    strings_at, strings_size = found["#Strings"]
    heap_sizes = data[table_stream[0] + 6]
    string_width = 4 if heap_sizes & 1 else 2
    guid_width = 4 if heap_sizes & 2 else 2
    blob_width = 4 if heap_sizes & 4 else 2
    valid = struct.unpack_from("<Q", data, table_stream[0] + 8)[0]
    cursor = table_stream[0] + 24
    rows: dict[int, int] = {}
    for table in range(64):
        if valid >> table & 1:
            rows[table] = struct.unpack_from("<I", data, cursor)[0]
            cursor += 4
    if ASSEMBLY_REF not in rows:
        return []

    def coded_width(name: str) -> int:
        bits, targets = CODED[name]
        biggest = max((rows.get(t, 0) for t in targets if t is not None), default=0)
        return 4 if biggest >= 1 << (16 - bits) else 2

    def column_width(kind) -> int:  # noqa: ANN001
        if kind == "u1":
            return 1
        if kind == "u2":
            return 2
        if kind == "u4":
            return 4
        if kind == "S":
            return string_width
        if kind == "G":
            return guid_width
        if kind == "B":
            return blob_width
        if kind[0] == "T":
            return 4 if rows.get(kind[1], 0) > 0xFFFF else 2
        return coded_width(kind[1])

    for table in range(ASSEMBLY_REF):
        if table in rows:
            if table not in TABLES:
                raise MetadataError(f"unsupported metadata table 0x{table:02X}")
            cursor += rows[table] * sum(column_width(k) for k in TABLES[table])
    names = []
    row_size = 12 + blob_width + 2 * string_width + blob_width
    for _ in range(rows[ASSEMBLY_REF]):
        name_at = cursor + 12 + blob_width
        index = int.from_bytes(data[name_at : name_at + string_width], "little")
        if index >= strings_size:
            raise MetadataError("AssemblyRef name outside the #Strings heap")
        begin = strings_at + index
        names.append(data[begin : data.index(b"\0", begin)].decode("utf-8", "replace"))
        cursor += row_size
    return names


def host_references(data: bytes) -> list[str]:
    return sorted({name for name in assembly_ref_names(data) if name.startswith(BANNED_PREFIX)})


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
