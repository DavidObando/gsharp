#!/usr/bin/env python3
"""Fail when a netstandard2.0 / .NET Framework assembly references a type or member its target does not have.

Issue #4924: gsc bound `s.Split(',')` in the netstandard2.0 MSBuild task
(`tools/task/Gsharp.NET.Sdk.dll`) to the build host's
`String.Split(char, StringSplitOptions)`. netstandard2.0 has only
`Split(params char[])`, so Visual Studio's MSBuild (.NET Framework) failed with
MissingMethodException. `check-netstandard-host-refs.py` (issue #4921) only
reads AssemblyRefs, and this MemberRef names `netstandard`, so it passed.

This check resolves every TypeRef and MemberRef of each checked assembly against
a reference surface (reference assemblies; for the SDK task, NETStandard.Library's
netstandard2.0 `netstandard.dll` and facades plus the Microsoft.Build reference
assemblies it compiles against):

  * a TypeRef must name a type that a surface assembly declares, following type
    forwarders (`System.Runtime` -> `netstandard`) and nested types;
  * a MemberRef whose parent is such a type (or a generic instantiation of one)
    must name a method or field of that type, or of one of its base types or base
    interfaces, with the same name and the same signature. Signatures are compared
    after resolving every type in them to its declaring assembly, so a type spelled
    through a facade matches its declaration.

A reference into an assembly that is not on the surface is reported as well:
the surface must cover every assembly the checked one references.

Checked inputs (fail closed: a missing or empty set is an error, never a pass):
  * a `.dll` path is checked directly;
  * a `.nupkg` is opened and every `tools/task/*.dll` plus every
    `lib|ref/netstandard*/*.dll` and `lib|ref/net4*/*.dll` entry is checked.
With no inputs every `Gsharp.NET.Sdk.*.nupkg` in out/bin/Release/nupkgs is checked.

Surface: `--surface PATH` (a directory of reference assemblies or one `.dll`,
repeatable). Without it the default is the SDK task's own netstandard2.0 compile
references, taken from the NuGet package cache (`NUGET_PACKAGES`, else
`~/.nuget/packages`) at the versions locked in
`src/Sdk/Gsharp.NET.Sdk/packages.lock.json`. A surface without `netstandard` is an
error.

Usage: check-netstandard-member-refs.py [--surface PATH ...] [PATH ...]
Exit status 0 when clean, 1 with one line per finding, 2 when nothing was checked
or the surface is unusable.
"""

from __future__ import annotations

import fnmatch
import json
import os
import struct
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_GLOB = "out/bin/Release/nupkgs/Gsharp.NET.Sdk.*.nupkg"
PACKAGE_ENTRY_PATTERNS = (
    "tools/task/*.dll",
    "lib/netstandard*/*.dll",
    "lib/net4*/*.dll",
    "ref/netstandard*/*.dll",
    "ref/net4*/*.dll",
)
LOCK_FILE = REPO / "src" / "Sdk" / "Gsharp.NET.Sdk" / "packages.lock.json"
# (package id, folder inside the package) of the task's netstandard2.0 compile references.
DEFAULT_SURFACE_PACKAGES = (
    ("NETStandard.Library", "build/netstandard2.0/ref"),
    ("Microsoft.Build.Framework", "ref/netstandard2.0"),
    ("Microsoft.Build.Utilities.Core", "ref/netstandard2.0"),
)


class MetadataError(ValueError):
    pass


# ECMA-335 II.24.2.6 coded indices: (tag bits, tables by tag; None marks an unused tag).
CODED = {
    "TypeDefOrRef": (2, (0x02, 0x01, 0x1B)),
    "HasConstant": (2, (0x04, 0x08, 0x17)),
    "HasCustomAttribute": (
        5,
        (0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0A, 0x00, 0x0E, 0x17, 0x14, 0x11, 0x1A, 0x1B, 0x20, 0x23, 0x26, 0x27, 0x28, 0x2A, 0x2C, 0x2B),
    ),
    "HasFieldMarshal": (1, (0x04, 0x08)),
    "HasDeclSecurity": (2, (0x02, 0x06, 0x20)),
    "MemberRefParent": (3, (0x02, 0x01, 0x1A, 0x06, 0x1B)),
    "HasSemantics": (1, (0x14, 0x17)),
    "MethodDefOrRef": (1, (0x06, 0x0A)),
    "MemberForwarded": (1, (0x04, 0x06)),
    "Implementation": (2, (0x26, 0x23, 0x27)),
    "CustomAttributeType": (3, (None, None, 0x06, 0x0A, None)),
    "ResolutionScope": (2, (0x00, 0x1A, 0x23, 0x01)),
    "TypeOrMethodDef": (1, (0x02, 0x06)),
}
C = lambda name: ("C", name)  # noqa: E731
T = lambda table: ("T", table)  # noqa: E731
# Column layout of every table a PE image can carry (ECMA-335 II.22).
TABLES = {
    0x00: ["u2", "S", "G", "G", "G"],  # Module
    0x01: [C("ResolutionScope"), "S", "S"],  # TypeRef
    0x02: ["u4", "S", "S", C("TypeDefOrRef"), T(0x04), T(0x06)],  # TypeDef
    0x03: [T(0x04)],  # FieldPtr
    0x04: ["u2", "S", "B"],  # Field
    0x05: [T(0x06)],  # MethodPtr
    0x06: ["u4", "u2", "u2", "S", "B", T(0x08)],  # MethodDef
    0x07: [T(0x08)],  # ParamPtr
    0x08: ["u2", "u2", "S"],  # Param
    0x09: [T(0x02), C("TypeDefOrRef")],  # InterfaceImpl
    0x0A: [C("MemberRefParent"), "S", "B"],  # MemberRef
    0x0B: ["u2", C("HasConstant"), "B"],  # Constant
    0x0C: [C("HasCustomAttribute"), C("CustomAttributeType"), "B"],  # CustomAttribute
    0x0D: [C("HasFieldMarshal"), "B"],  # FieldMarshal
    0x0E: ["u2", C("HasDeclSecurity"), "B"],  # DeclSecurity
    0x0F: ["u2", "u4", T(0x02)],  # ClassLayout
    0x10: ["u4", T(0x04)],  # FieldLayout
    0x11: ["B"],  # StandAloneSig
    0x12: [T(0x02), T(0x14)],  # EventMap
    0x13: [T(0x14)],  # EventPtr
    0x14: ["u2", "S", C("TypeDefOrRef")],  # Event
    0x15: [T(0x02), T(0x17)],  # PropertyMap
    0x16: [T(0x17)],  # PropertyPtr
    0x17: ["u2", "S", "B"],  # Property
    0x18: ["u2", T(0x06), C("HasSemantics")],  # MethodSemantics
    0x19: [T(0x02), C("MethodDefOrRef"), C("MethodDefOrRef")],  # MethodImpl
    0x1A: ["S"],  # ModuleRef
    0x1B: ["B"],  # TypeSpec
    0x1C: ["u2", C("MemberForwarded"), "S", T(0x1A)],  # ImplMap
    0x1D: ["u4", T(0x04)],  # FieldRVA
    0x1E: ["u4", "u4"],  # EncLog
    0x1F: ["u4"],  # EncMap
    0x20: ["u4", "u2", "u2", "u2", "u2", "u4", "B", "S", "S"],  # Assembly
    0x21: ["u4"],  # AssemblyProcessor
    0x22: ["u4", "u4", "u4"],  # AssemblyOS
    0x23: ["u2", "u2", "u2", "u2", "u4", "B", "S", "S", "B"],  # AssemblyRef
    0x24: ["u4", T(0x23)],  # AssemblyRefProcessor
    0x25: ["u4", "u4", "u4", T(0x23)],  # AssemblyRefOS
    0x26: ["u4", "S", "B"],  # File
    0x27: ["u4", "u4", "S", "S", C("Implementation")],  # ExportedType
    0x28: ["u4", "u4", "S", C("Implementation")],  # ManifestResource
    0x29: [T(0x02), T(0x02)],  # NestedClass
    0x2A: ["u2", "u2", C("TypeOrMethodDef"), "S"],  # GenericParam
    0x2B: [C("MethodDefOrRef"), "B"],  # MethodSpec
    0x2C: [T(0x2A), C("TypeDefOrRef")],  # GenericParamConstraint
}
TYPEDEF, TYPEREF, FIELD, METHODDEF, INTERFACEIMPL, MEMBERREF = 0x02, 0x01, 0x04, 0x06, 0x09, 0x0A
MODULEREF, TYPESPEC, ASSEMBLY, ASSEMBLYREF, EXPORTEDTYPE, NESTEDCLASS = 0x1A, 0x1B, 0x20, 0x23, 0x27, 0x29


def decode_coded(name: str, value: int) -> tuple[int | None, int]:
    """Returns (table, 1-based row) of a coded index; row 0 is a nil reference."""
    bits, targets = CODED[name]
    tag = value & ((1 << bits) - 1)
    return (targets[tag] if tag < len(targets) else None), value >> bits


class Metadata:
    """The metadata tables and heaps of one managed PE image."""

    def __init__(self, data: bytes, label: str) -> None:
        self.label = label
        self.data = data
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
        table_stream = found.get("#~") or found.get("#-")
        if table_stream is None or "#Strings" not in found:
            raise MetadataError("no metadata table stream or #Strings heap")
        self.strings = found["#Strings"]
        self.blobs = found.get("#Blob", (0, 0))
        start = table_stream[0]
        heap_sizes = data[start + 6]
        widths = {"S": 4 if heap_sizes & 1 else 2, "G": 4 if heap_sizes & 2 else 2, "B": 4 if heap_sizes & 4 else 2}
        valid = struct.unpack_from("<Q", data, start + 8)[0]
        cursor = start + 24
        self.rows: dict[int, int] = {}
        for table in range(64):
            if valid >> table & 1:
                self.rows[table] = struct.unpack_from("<I", data, cursor)[0]
                cursor += 4
        if heap_sizes & 0x40:
            cursor += 4  # extra data (uncompressed #- streams)

        def width(kind) -> int:  # noqa: ANN001
            if kind in ("u2", "u4"):
                return int(kind[1])
            if kind in widths:
                return widths[kind]
            if kind[0] == "T":
                return 4 if self.rows.get(kind[1], 0) > 0xFFFF else 2
            bits, targets = CODED[kind[1]]
            biggest = max((self.rows.get(t, 0) for t in targets if t is not None), default=0)
            return 4 if biggest >= 1 << (16 - bits) else 2

        self.tables: dict[int, list[tuple[int, ...]]] = {}
        for table in sorted(self.rows):
            if table not in TABLES:
                raise MetadataError(f"unsupported metadata table 0x{table:02X}")
            columns = [width(kind) for kind in TABLES[table]]
            decoded = []
            for _ in range(self.rows[table]):
                row = []
                for size in columns:
                    row.append(int.from_bytes(data[cursor : cursor + size], "little"))
                    cursor += size
                decoded.append(tuple(row))
            self.tables[table] = decoded
        assembly = self.tables.get(ASSEMBLY)
        self.name = self.string(assembly[0][7]) if assembly else None
        self._nested_in = {nested: enclosing for nested, enclosing in self.tables.get(NESTEDCLASS, [])}
        self._nested: dict[tuple[int, str], int] = {}
        for nested, enclosing in self._nested_in.items():
            self._nested[(enclosing, self.typedef_name(nested))] = nested
        self._top: dict[tuple[str, str], int] = {}
        for row in range(1, self.rows.get(TYPEDEF, 0) + 1):
            if row not in self._nested_in:
                self._top.setdefault((self.typedef_namespace(row), self.typedef_name(row)), row)
        self._exported: dict[tuple[str, str], tuple[int | None, int]] = {}
        for _, _, name, namespace, implementation in self.tables.get(EXPORTEDTYPE, []):
            self._exported.setdefault(
                (self.string(namespace), self.string(name)), decode_coded("Implementation", implementation)
            )

    def row(self, table: int, row: int) -> tuple[int, ...]:
        rows = self.tables.get(table, [])
        if not 1 <= row <= len(rows):
            raise MetadataError(f"row {row} of table 0x{table:02X} out of range")
        return rows[row - 1]

    def string(self, index: int) -> str:
        at, size = self.strings
        if index >= size:
            raise MetadataError("#Strings index out of range")
        begin = at + index
        return self.data[begin : self.data.index(b"\0", begin)].decode("utf-8", "replace")

    def blob(self, index: int) -> bytes:
        at, size = self.blobs
        if index >= size:
            raise MetadataError("#Blob index out of range")
        length, used = compressed(self.data, at + index)
        begin = at + index + used
        return self.data[begin : begin + length]

    def typedef_name(self, row: int) -> str:
        return self.string(self.row(TYPEDEF, row)[1])

    def typedef_namespace(self, row: int) -> str:
        return self.string(self.row(TYPEDEF, row)[2])

    def typedef_full_name(self, row: int) -> str:
        enclosing = self._nested_in.get(row)
        if enclosing is not None:
            return self.typedef_full_name(enclosing) + "/" + self.typedef_name(row)
        namespace = self.typedef_namespace(row)
        return (namespace + "." if namespace else "") + self.typedef_name(row)

    def member_range(self, table: int, row: int, column: int, target: int) -> range:
        rows = self.tables[table]
        first = rows[row - 1][column]
        last = rows[row][column] if row < len(rows) else self.rows.get(target, 0) + 1
        return range(first, last)

    def find_top_level(self, namespace: str, name: str) -> int | None:
        return self._top.get((namespace, name))

    def find_nested(self, enclosing: int, name: str) -> int | None:
        return self._nested.get((enclosing, name))

    def forwarder(self, namespace: str, name: str) -> tuple[int | None, int] | None:
        return self._exported.get((namespace, name))

    def assembly_ref_name(self, row: int) -> str:
        return self.string(self.row(ASSEMBLYREF, row)[6])


def compressed(data: bytes, at: int) -> tuple[int, int]:
    """ECMA-335 II.23.2 compressed unsigned integer: (value, bytes used)."""
    first = data[at]
    if first & 0x80 == 0:
        return first, 1
    if first & 0xC0 == 0x80:
        return ((first & 0x3F) << 8) | data[at + 1], 2
    if first & 0xE0 == 0xC0:
        return ((first & 0x1F) << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3], 4
    raise MetadataError("bad compressed integer")


PRIMITIVES = {
    0x01: "void", 0x02: "bool", 0x03: "char", 0x04: "sbyte", 0x05: "byte", 0x06: "short", 0x07: "ushort",
    0x08: "int", 0x09: "uint", 0x0A: "long", 0x0B: "ulong", 0x0C: "float", 0x0D: "double", 0x0E: "string",
    0x16: "typedref", 0x18: "nint", 0x19: "nuint", 0x1C: "object",
}  # fmt: skip


# A primitive spelled as a CLASS/VALUETYPE reference reads the same as its element-type code.
PRIMITIVE_NAMES = {
    "System.Void": "void", "System.Boolean": "bool", "System.Char": "char", "System.SByte": "sbyte",
    "System.Byte": "byte", "System.Int16": "short", "System.UInt16": "ushort", "System.Int32": "int",
    "System.UInt32": "uint", "System.Int64": "long", "System.UInt64": "ulong", "System.Single": "float",
    "System.Double": "double", "System.String": "string", "System.TypedReference": "typedref",
    "System.IntPtr": "nint", "System.UIntPtr": "nuint", "System.Object": "object",
}  # fmt: skip


class Surface:
    """Reference assemblies by simple name, and type resolution across them."""

    def __init__(self, assemblies: dict[str, Metadata]) -> None:
        self.assemblies = assemblies
        # The core library: the assembly that declares System.Object itself.
        self.core = next(
            (m for m in assemblies.values() if m.find_top_level("System", "Object") is not None and m.row(TYPEDEF, m.find_top_level("System", "Object"))[3] == 0),
            None,
        )

    def canonical_name(self, metadata: Metadata, row: int) -> str:
        """A declaration's name qualified by its declaring assembly, so same-named types in
        different assemblies differ while a forwarded spelling matches its declaration."""
        full_name = metadata.typedef_full_name(row)
        if metadata is self.core and full_name in PRIMITIVE_NAMES:
            return PRIMITIVE_NAMES[full_name]
        return f"[{metadata.name}]{full_name}"

    def resolve(self, assembly: str, namespace: str, path: list[str], depth: int = 0) -> tuple[Metadata, int] | None:
        """Resolves type `namespace.path[0]/path[1]/...` declared or forwarded by `assembly`."""
        metadata = self.assemblies.get(assembly)
        if metadata is None or depth > 16:
            return None
        row = metadata.find_top_level(namespace, path[0])
        if row is None:
            forwarded = metadata.forwarder(namespace, path[0])
            if forwarded is None or forwarded[0] != ASSEMBLYREF:
                return None
            return self.resolve(metadata.assembly_ref_name(forwarded[1]), namespace, path, depth + 1)
        for name in path[1:]:
            row = metadata.find_nested(row, name)
            if row is None:
                return None
        return metadata, row

    def resolve_typeref(self, metadata: Metadata, row: int) -> tuple[Metadata, int] | None:
        scope, name, namespace = metadata.row(TYPEREF, row)
        path = [metadata.string(name)]
        table, target = decode_coded("ResolutionScope", scope)
        while table == TYPEREF:
            scope, name, namespace = metadata.row(TYPEREF, target)
            path.insert(0, metadata.string(name))
            table, target = decode_coded("ResolutionScope", scope)
        if table == ASSEMBLYREF:
            return self.resolve(metadata.assembly_ref_name(target), metadata.string(namespace), path)
        if table == 0x00 and metadata.name is not None:  # the module itself
            return self.resolve(metadata.name, metadata.string(namespace), path)
        return None

    def resolve_type_handle(self, metadata: Metadata, coded: int) -> tuple[Metadata, int] | None:
        """Resolves a TypeDefOrRef coded index to its declaring TypeDef (a TypeSpec to its generic definition)."""
        table, row = decode_coded("TypeDefOrRef", coded)
        if row == 0:
            return None
        if table == TYPEDEF:
            return metadata, row
        if table == TYPEREF:
            return self.resolve_typeref(metadata, row)
        if table == TYPESPEC:
            return self.generic_definition(metadata, metadata.blob(metadata.row(TYPESPEC, row)[0]))
        return None

    def generic_definition(self, metadata: Metadata, signature: bytes) -> tuple[Metadata, int] | None:
        if not signature or signature[0] != 0x15:  # GENERICINST
            return None
        coded, _ = compressed(signature, 2)
        return self.resolve_type_handle(metadata, coded)


class SignatureReader:
    """Decodes signature blobs to a canonical text in which every type is named by its declaration."""

    def __init__(self, surface: Surface, metadata: Metadata, blob: bytes, type_arguments: list[str] | None = None) -> None:
        self.surface = surface
        self.metadata = metadata
        self.blob = blob
        self.at = 0
        # The enclosing type's generic arguments: a `!n` in the blob reads as the nth
        # argument, so an inherited member is compared as the derived type sees it.
        self.type_arguments = type_arguments

    def u(self) -> int:
        value, used = compressed(self.blob, self.at)
        self.at += used
        return value

    def byte(self) -> int:
        value = self.blob[self.at]
        self.at += 1
        return value

    def type_name(self, coded: int) -> str:
        table, row = decode_coded("TypeDefOrRef", coded)
        if table == TYPESPEC:
            spec = self.metadata.blob(self.metadata.row(TYPESPEC, row)[0])
            return SignatureReader(self.surface, self.metadata, spec, self.type_arguments).type()
        resolved = self.surface.resolve_type_handle(self.metadata, coded)
        if resolved is not None:
            return self.surface.canonical_name(*resolved)
        # Unresolvable: named as written, so it can still match nothing on the surface.
        return "?" + type_ref_label(self.metadata, row)

    def type(self) -> str:
        code = self.byte()
        if code in PRIMITIVES:
            return PRIMITIVES[code]
        if code in (0x11, 0x12):  # VALUETYPE, CLASS
            return self.type_name(self.u())
        if code == 0x0F:
            return self.type() + "*"
        if code == 0x10:
            return self.type() + "&"
        if code == 0x45:
            return self.type() + " pinned"
        if code == 0x1D:
            return self.type() + "[]"
        if code == 0x14:  # ARRAY
            element = self.type()
            rank = self.u()
            for _ in range(self.u()):
                self.u()
            for _ in range(self.u()):
                self.u()  # lower bounds are signed compressed; only their width matters here
            # A rank-one ARRAY (`T[*]`) is a different type from the vector `T[]`.
            return f"{element}[{'*' if rank == 1 else ',' * (rank - 1)}]"
        if code == 0x13:
            index = self.u()
            if self.type_arguments is not None and index < len(self.type_arguments):
                return self.type_arguments[index]
            return f"!{index}"
        if code == 0x1E:
            return f"!!{self.u()}"
        if code == 0x15:  # GENERICINST
            self.byte()
            definition = self.type_name(self.u())
            arguments = [self.type() for _ in range(self.u())]
            return f"{definition}<{','.join(arguments)}>"
        if code in (0x1F, 0x20):  # CMOD_REQD, CMOD_OPT
            modifier = self.type_name(self.u())
            return f"{self.type()} {'modreq' if code == 0x1F else 'modopt'}({modifier})"
        if code == 0x1B:  # FNPTR
            return "fnptr" + self.method()
        if code == 0x41:  # SENTINEL
            return "..." + self.type()
        raise MetadataError(f"unsupported signature element 0x{code:02X}")

    def method(self) -> str:
        convention = self.byte()
        generic = self.u() if convention & 0x10 else 0
        count = self.u()
        returns = self.type()
        parameters = [self.type() for _ in range(count)]
        prefix = f"<{generic}>" if generic else ""
        static = "" if convention & 0x20 else " static"
        return f"{prefix}({', '.join(parameters)}) : {returns}{static}{' vararg' if convention & 0x0F == 5 else ''}"

    def field(self) -> str:
        if self.byte() != 0x06:
            raise MetadataError("not a field signature")
        return self.type()

    def generic_arguments(self) -> list[str]:
        """The canonical type arguments of a GENERICINST TypeSpec blob."""
        if self.byte() != 0x15:
            raise MetadataError("not a generic instantiation")
        self.byte()
        self.u()
        return [self.type() for _ in range(self.u())]

    def member(self) -> tuple[bool, str]:
        """(is field, canonical signature) of a MemberRef signature."""
        if self.blob and self.blob[0] == 0x06:
            return True, self.field()
        return False, self.method()


def inherited(surface: Surface, metadata: Metadata, coded: int, type_arguments: list[str] | None) -> tuple[Metadata, int, list[str] | None] | None:
    """A base type or interface (a TypeDefOrRef coded index of `metadata`) with the generic
    arguments it is instantiated with, read in the deriving type's own argument context."""
    resolved = surface.resolve_type_handle(metadata, coded)
    if resolved is None:
        return None
    table, row = decode_coded("TypeDefOrRef", coded)
    arguments = None
    if table == TYPESPEC:
        spec = metadata.blob(metadata.row(TYPESPEC, row)[0])
        arguments = SignatureReader(surface, metadata, spec, type_arguments).generic_arguments()
    return resolved[0], resolved[1], arguments


def find_member(surface: Surface, declaring: tuple[Metadata, int], name: str, is_field: bool, signature: str) -> bool:
    """Whether `declaring`, one of its base types or one of its base interfaces declares the member.

    `signature` is the MemberRef's canonical signature; its `!n` name the declaring type's
    own generic parameters. A member found on a generic base is read with the base's
    arguments substituted (`Base<T>.Add(T)` reached from `Derived : Base<string>` reads as
    `Add(string)`)."""
    pending: list[tuple[Metadata, int, list[str] | None]] = [(declaring[0], declaring[1], None)]
    seen: set[tuple[int, int, str]] = set()
    while pending:
        metadata, row, type_arguments = pending.pop()
        key = (id(metadata), row, repr(type_arguments))
        if key in seen:
            continue
        seen.add(key)
        typedef = metadata.row(TYPEDEF, row)
        if is_field:
            for field in metadata.member_range(TYPEDEF, row, 4, FIELD):
                _, field_name, field_signature = metadata.row(FIELD, field)
                if metadata.string(field_name) == name and SignatureReader(
                    surface, metadata, metadata.blob(field_signature), type_arguments
                ).field() == signature:
                    return True
        else:
            for method in metadata.member_range(TYPEDEF, row, 5, METHODDEF):
                method_row = metadata.row(METHODDEF, method)
                if metadata.string(method_row[3]) == name and SignatureReader(
                    surface, metadata, metadata.blob(method_row[4]), type_arguments
                ).method() == signature:
                    return True
        if name in (".ctor", ".cctor"):
            return False
        if typedef[3]:
            base = inherited(surface, metadata, typedef[3], type_arguments)
            if base is not None:
                pending.append(base)
        for implementer, interface in metadata.tables.get(INTERFACEIMPL, []):
            if implementer == row:
                resolved = inherited(surface, metadata, interface, type_arguments)
                if resolved is not None:
                    pending.append(resolved)
    return False


def type_ref_label(metadata: Metadata, row: int) -> str:
    scope, name, namespace = metadata.row(TYPEREF, row)
    table, target = decode_coded("ResolutionScope", scope)
    if table == TYPEREF:
        return type_ref_label(metadata, target) + "/" + metadata.string(name)
    prefix = f"[{metadata.assembly_ref_name(target)}]" if table == ASSEMBLYREF else ""
    space = metadata.string(namespace)
    return prefix + (space + "." if space else "") + metadata.string(name)


def type_ref_assembly(metadata: Metadata, row: int) -> str | None:
    table, target = decode_coded("ResolutionScope", metadata.row(TYPEREF, row)[0])
    while table == TYPEREF:
        table, target = decode_coded("ResolutionScope", metadata.row(TYPEREF, target)[0])
    return metadata.assembly_ref_name(target) if table == ASSEMBLYREF else None


def check_metadata(surface: Surface, metadata: Metadata) -> tuple[int, int, list[str]]:
    """Returns (TypeRefs checked, MemberRefs checked, findings)."""
    findings: list[str] = []
    missing_assemblies: set[str] = set()
    type_refs = 0
    for row in range(1, metadata.rows.get(TYPEREF, 0) + 1):
        assembly = type_ref_assembly(metadata, row)
        if assembly is None:
            continue
        type_refs += 1
        if assembly not in surface.assemblies:
            missing_assemblies.add(assembly)
            continue
        if surface.resolve_typeref(metadata, row) is None:
            findings.append(f"TypeRef {type_ref_label(metadata, row)} is not declared on the reference surface")
    member_refs = 0
    for row in range(1, metadata.rows.get(MEMBERREF, 0) + 1):
        parent, name_index, signature_index = metadata.row(MEMBERREF, row)
        table, target = decode_coded("MemberRefParent", parent)
        if table == TYPEREF:
            if type_ref_assembly(metadata, target) is None:
                continue
            declaring = surface.resolve_typeref(metadata, target)
            parent_label = type_ref_label(metadata, target)
        elif table == TYPESPEC:
            spec = metadata.blob(metadata.row(TYPESPEC, target)[0])
            if not spec or spec[0] != 0x15:
                continue  # arrays and pointers: the runtime supplies their members
            coded, _ = compressed(spec, 2)
            spec_table, spec_row = decode_coded("TypeDefOrRef", coded)
            if spec_table != TYPEREF or type_ref_assembly(metadata, spec_row) is None:
                continue
            declaring = surface.resolve_typeref(metadata, spec_row)
            parent_label = SignatureReader(surface, metadata, spec).type()
        else:
            continue  # this module's own TypeDefs, MethodDefs (varargs) and ModuleRefs
        member_refs += 1
        name = metadata.string(name_index)
        is_field, signature = SignatureReader(surface, metadata, metadata.blob(signature_index)).member()
        label = f"{parent_label}::{name}{' : ' + signature if is_field else signature}"
        if declaring is None:
            continue  # its TypeRef is already reported above
        if not find_member(surface, declaring, name, is_field, signature):
            findings.append(f"MemberRef {label} does not exist on the reference surface")
    for assembly in sorted(missing_assemblies):
        findings.append(f"references assembly '{assembly}', which is not on the reference surface")
    return type_refs, member_refs, findings


def check_image(surface: Surface, label: str, data: bytes) -> tuple[int, list[str]]:
    """Returns (references checked, findings) for one image."""
    try:
        type_refs, member_refs, findings = check_metadata(surface, Metadata(data, label))
    except (MetadataError, struct.error, ValueError, IndexError) as error:
        return 0, [f"{label}: cannot read metadata ({error})"]
    if type_refs == 0:
        findings.append("no external TypeRef was found to check")
    return type_refs + member_refs, [f"{label}: {line} (issue #4924)" for line in findings]


def check_path(surface: Surface, path: Path) -> tuple[int, int, list[str]]:
    """Returns (assemblies checked, references checked, findings)."""
    images: list[tuple[str, bytes]] = []
    if path.suffix == ".nupkg":
        with zipfile.ZipFile(path) as package:
            for entry in sorted(package.namelist()):
                if any(fnmatch.fnmatchcase(entry, p) for p in PACKAGE_ENTRY_PATTERNS):
                    images.append((f"{path.name}!{entry}", package.read(entry)))
    else:
        images.append((str(path), path.read_bytes()))
    references = 0
    findings: list[str] = []
    for label, data in images:
        checked, found = check_image(surface, label, data)
        references += checked
        findings += found
    return len(images), references, findings


def load_surface(paths: list[Path]) -> tuple[Surface, list[str]]:
    assemblies: dict[str, Metadata] = {}
    errors: list[str] = []
    for path in paths:
        files = sorted(path.glob("*.dll")) if path.is_dir() else [path]
        if not path.exists() or not files:
            errors.append(f"surface {path}: no reference assemblies")
            continue
        for file in files:
            try:
                metadata = Metadata(file.read_bytes(), str(file))
            except (MetadataError, struct.error, ValueError, IndexError):
                continue  # not a managed assembly
            if metadata.name is not None:
                assemblies.setdefault(metadata.name, metadata)
    if "netstandard" not in assemblies:
        errors.append("the reference surface has no netstandard assembly")
    return Surface(assemblies), errors


def default_surface_paths() -> tuple[list[Path], list[str]]:
    root = Path(os.environ.get("NUGET_PACKAGES") or Path.home() / ".nuget" / "packages")
    try:
        locked = json.loads(LOCK_FILE.read_text(encoding="utf-8-sig"))["dependencies"][".NETStandard,Version=v2.0"]
    except (OSError, KeyError, ValueError) as error:
        return [], [f"cannot read the task's locked netstandard2.0 references from {LOCK_FILE} ({error})"]
    paths: list[Path] = []
    errors: list[str] = []
    for package, folder in DEFAULT_SURFACE_PACKAGES:
        version = locked.get(package, {}).get("resolved")
        if version is None:
            errors.append(f"{LOCK_FILE.name} locks no {package}")
            continue
        paths.append(root / package.lower() / version / folder)
    return paths, errors


def main(argv: list[str]) -> int:
    surface_paths: list[Path] = []
    inputs: list[Path] = []
    args = iter(argv)
    for arg in args:
        if arg == "--surface":
            value = next(args, None)
            if value is None:
                print("--surface requires a path")
                return 2
            surface_paths.append(Path(value))
        else:
            inputs.append(Path(arg))
    errors: list[str] = []
    if not surface_paths:
        surface_paths, errors = default_surface_paths()
    surface, surface_errors = load_surface(surface_paths)
    errors += surface_errors
    if errors:
        for line in errors:
            print(line)
        print("the reference surface is unusable; refusing to pass")
        return 2
    inputs = inputs or sorted(REPO.glob(DEFAULT_GLOB))
    assemblies = 0
    references = 0
    findings: list[str] = []
    for path in inputs:
        if not path.is_file():
            findings.append(f"{path}: no such file")
            continue
        checked, refs, found = check_path(surface, path)
        assemblies += checked
        references += refs
        findings += found
    for line in findings:
        print(line)
    if assemblies == 0:
        print("no netstandard2.0 / net4x assembly was found to check; refusing to pass vacuously")
        return 1 if findings else 2
    if findings:
        return 1
    print(
        f"ok: {assemblies} assembly(ies), {references} TypeRef/MemberRef(s) checked against "
        f"{len(surface.assemblies)} reference assembly(ies); every one resolves"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
