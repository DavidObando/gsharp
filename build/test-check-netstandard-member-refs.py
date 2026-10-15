#!/usr/bin/env python3
"""Regression tests for build/check-netstandard-member-refs.py (ADR-0154).

The tests synthesize small managed PE images (a CLI header and a metadata root
with real #~ tables and #Strings/#Blob/#GUID heaps), so they need no build
output: a "netstandard" surface that declares `String.Split(char[])` only, a
`System.Runtime` facade that forwards `System.String` to it, and checked images
that reference members through both. The bad image is the #4924 shape: a
MemberRef to `String.Split(char, StringSplitOptions)` scoped at `netstandard`.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import struct
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("check_member_refs", REPO / "build" / "check-netstandard-member-refs.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/check-netstandard-member-refs.py")
check = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = check
SPEC.loader.exec_module(check)

# Element types (ECMA-335 II.23.1.16).
VOID, BOOL, CHAR, I4, STRING, CLASS, VALUETYPE, SZARRAY, GENERICINST, VAR, OBJECT = (
    0x01, 0x02, 0x03, 0x08, 0x0E, 0x12, 0x11, 0x1D, 0x15, 0x13, 0x1C,
)  # fmt: skip
HASTHIS = 0x20


def coded(name: str, table: int, row: int) -> int:
    bits, targets = check.CODED[name]
    return (row << bits) | targets.index(table)


class Image:
    """Builds one assembly: rows are appended per table, heaps grow as values are added."""

    def __init__(self, name: str) -> None:
        self.strings = bytearray(b"\0")
        self.string_index: dict[str, int] = {}
        self.blobs = bytearray(b"\0")
        self.tables: dict[int, list[list[int]]] = {t: [] for t in check.TABLES}
        self.tables[0x00].append([0, self.s(name + ".dll"), 1, 0, 0])
        self.tables[check.ASSEMBLY].append([0x8004, 1, 0, 0, 0, 0, 0, self.s(name), 0])
        self.assembly_refs: dict[str, int] = {}
        self.add_typedef("", "<Module>")

    def s(self, text: str) -> int:
        if text == "":
            return 0
        if text not in self.string_index:
            self.string_index[text] = len(self.strings)
            self.strings += text.encode() + b"\0"
        return self.string_index[text]

    def b(self, data: bytes) -> int:
        index = len(self.blobs)
        assert len(data) < 0x80
        self.blobs += bytes([len(data)]) + data
        return index

    def add(self, table: int, row: list[int]) -> int:
        self.tables[table].append(row)
        return len(self.tables[table])

    def assembly_ref(self, name: str) -> int:
        if name not in self.assembly_refs:
            self.assembly_refs[name] = self.add(check.ASSEMBLYREF, [2, 0, 0, 0, 0, 0, self.s(name), 0, 0])
        return self.assembly_refs[name]

    def type_ref(self, assembly: str, namespace: str, name: str, enclosing: int | None = None) -> int:
        scope = (
            coded("ResolutionScope", check.TYPEREF, enclosing)
            if enclosing
            else coded("ResolutionScope", check.ASSEMBLYREF, self.assembly_ref(assembly))
        )
        return self.add(check.TYPEREF, [scope, self.s(name), self.s(namespace)])

    def add_typedef(self, namespace: str, name: str, extends: int = 0, enclosing: int | None = None) -> int:
        row = self.add(
            check.TYPEDEF,
            [0x1, self.s(name), self.s(namespace), extends, len(self.tables[check.FIELD]) + 1, len(self.tables[check.METHODDEF]) + 1],
        )
        if enclosing is not None:
            self.add(check.NESTEDCLASS, [row, enclosing])
        return row

    def method(self, name: str, signature: bytes) -> None:
        self.add(check.METHODDEF, [0, 0, 0x0086, self.s(name), self.b(signature), 1])

    def field(self, name: str, signature: bytes) -> None:
        self.add(check.FIELD, [0x0006, self.s(name), self.b(signature)])

    def forward(self, namespace: str, name: str, to: str) -> None:
        self.add(
            check.EXPORTEDTYPE,
            [0x00200000, 0, self.s(name), self.s(namespace), coded("Implementation", check.ASSEMBLYREF, self.assembly_ref(to))],
        )

    def member_ref(self, parent_table: int, parent_row: int, name: str, signature: bytes) -> None:
        self.add(check.MEMBERREF, [coded("MemberRefParent", parent_table, parent_row), self.s(name), self.b(signature)])

    def type_spec(self, signature: bytes) -> int:
        return self.add(check.TYPESPEC, [self.b(signature)])

    def build(self) -> bytes:
        # Every heap and table here is small, so every index is 2 bytes wide.
        strings = bytes(self.strings) + b"\0" * (-len(self.strings) % 4)
        blobs = bytes(self.blobs) + b"\0" * (-len(self.blobs) % 4)
        guids = b"\x11" * 16
        present = [t for t in sorted(self.tables) if self.tables[t]]
        valid = sum(1 << t for t in present)
        tables = struct.pack("<IBBBBQQ", 0, 2, 0, 0, 1, valid, 0)
        tables += b"".join(struct.pack("<I", len(self.tables[t])) for t in present)
        for table in present:
            for row in self.tables[table]:
                for kind, value in zip(check.TABLES[table], row, strict=True):
                    tables += struct.pack("<I" if kind == "u4" else "<H", value)
        tables += b"\0" * (-len(tables) % 4)
        version = b"v4.0.30319\0\0"
        names = [(b"#~\0\0", tables), (b"#Strings\0\0\0\0", strings), (b"#GUID\0\0\0", guids), (b"#Blob\0\0\0", blobs)]
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
        struct.pack_into("<I", optional, 92, 16)
        struct.pack_into("<II", optional, 96 + 14 * 8, section_rva, 72)
        coff = struct.pack("<HHIIIHH", 0x14C, 1, 0, 0, 0, len(optional), 0x2000)
        section = b".text\0\0\0" + struct.pack("<IIII", len(body), section_rva, len(body), raw_ptr) + b"\0" * 16
        header = bytearray(0x80) + b"PE\0\0" + coff + bytes(optional) + section
        struct.pack_into("<I", header, 0x3C, 0x80)
        header[0:2] = b"MZ"
        return bytes(header) + b"\0" * (raw_ptr - len(header)) + body


def method_sig(returns: bytes, *parameters: bytes, instance: bool = True) -> bytes:
    return bytes([HASTHIS if instance else 0, len(parameters)]) + returns + b"".join(parameters)


def class_of(table: int, row: int, kind: int = CLASS) -> bytes:
    value = coded("TypeDefOrRef", table, row)
    assert value < 0x80
    return bytes([kind, value])


def netstandard() -> bytes:
    """The surface's core library: `String` has `Split(char[])` and `Trim()`, but no `Split(char, StringSplitOptions)`."""
    image = Image("netstandard")
    obj = image.add_typedef("System", "Object")
    image.method("ToString", method_sig(bytes([STRING])))
    image.method(".ctor", method_sig(bytes([VOID])))
    td = check.TYPEDEF
    value_type = image.add_typedef("System", "ValueType", coded("TypeDefOrRef", td, obj))
    enum = image.add_typedef("System", "Enum", coded("TypeDefOrRef", td, value_type))
    image.add_typedef("System", "Char", coded("TypeDefOrRef", td, value_type))
    string = image.add_typedef("System", "String", coded("TypeDefOrRef", td, obj))
    image.method("Split", method_sig(bytes([SZARRAY, STRING]), bytes([SZARRAY, CHAR])))
    image.method("Trim", method_sig(bytes([STRING])))
    image.add_typedef("System", "StringSplitOptions", coded("TypeDefOrRef", td, enum))
    image.field("value__", bytes([0x06, I4]))
    image.add_typedef("System.Collections.Generic", "List`1", coded("TypeDefOrRef", td, obj))
    image.method("Add", method_sig(bytes([VOID]), bytes([VAR, 0])))
    outer = image.add_typedef("System", "Outer", coded("TypeDefOrRef", td, obj))
    image.add_typedef("", "Inner", coded("TypeDefOrRef", td, obj), enclosing=outer)
    image.field("Value", bytes([0x06, I4]))
    # Base<T>.Add(T), and Derived : Base<string>, which inherits it as Add(string).
    generic_base = image.add_typedef("System", "Base`1", coded("TypeDefOrRef", td, obj))
    image.method("Add", method_sig(bytes([VOID]), bytes([VAR, 0])))
    base_of_string = image.type_spec(bytes([GENERICINST]) + class_of(td, generic_base) + bytes([1, STRING]))
    image.add_typedef("System", "Derived", coded("TypeDefOrRef", check.TYPESPEC, base_of_string))
    assert string
    return image.build()


def contracts(name: str, *, with_api: bool) -> bytes:
    """An assembly declaring `Contracts.Token`; with `with_api`, also `Contracts.Api.Accept(Token)`."""
    image = Image(name)
    obj = coded("TypeDefOrRef", check.TYPEREF, image.type_ref("netstandard", "System", "Object"))
    token = image.add_typedef("Contracts", "Token", obj)
    if with_api:
        image.add_typedef("Contracts", "Api", obj)
        image.method("Accept", method_sig(bytes([VOID]), class_of(check.TYPEDEF, token)))
    return image.build()


def system_runtime_facade() -> bytes:
    image = Image("System.Runtime")
    image.forward("System", "String", "netstandard")
    image.forward("System", "Object", "netstandard")
    return image.build()


def checked_image(
    *,
    bad_split: bool = False,
    missing_type: bool = False,
    missing_member: bool = False,
    host_ref: bool = False,
    token_from: str | None = None,
    rank_one_split: bool = False,
    bad_inherited: bool = False,
) -> bytes:
    """A netstandard2.0 library. By default every reference resolves; each flag adds one bad reference."""
    image = Image("Lib")
    obj = image.type_ref("netstandard", "System", "Object")
    image.add_typedef("Lib", "Holder", coded("TypeDefOrRef", check.TYPEREF, obj))
    string = image.type_ref("netstandard", "System", "String")
    options = image.type_ref("netstandard", "System", "StringSplitOptions")
    image.member_ref(check.TYPEREF, string, "Split", method_sig(bytes([SZARRAY, STRING]), bytes([SZARRAY, CHAR])))
    # Inherited: ToString is declared by System.Object, the reference names System.String.
    image.member_ref(check.TYPEREF, string, "ToString", method_sig(bytes([STRING])))
    # Through the facade: System.Runtime forwards String to netstandard.
    facade_string = image.type_ref("System.Runtime", "System", "String")
    image.member_ref(check.TYPEREF, facade_string, "Trim", method_sig(bytes([STRING])))
    # A primitive spelled as a class reference is the same parameter type as its element-type code.
    image.member_ref(check.TYPEREF, string, "Split", method_sig(bytes([SZARRAY, STRING]), bytes([SZARRAY]) + class_of(check.TYPEREF, image.type_ref("netstandard", "System", "Char"), VALUETYPE)))
    list_ref = image.type_ref("netstandard", "System.Collections.Generic", "List`1")
    spec = image.type_spec(bytes([GENERICINST]) + class_of(check.TYPEREF, list_ref) + bytes([1, I4]))
    image.member_ref(check.TYPESPEC, spec, "Add", method_sig(bytes([VOID]), bytes([VAR, 0])))
    outer = image.type_ref("netstandard", "System", "Outer")
    inner = image.type_ref("netstandard", "", "Inner", enclosing=outer)
    image.member_ref(check.TYPEREF, inner, "Value", bytes([0x06, I4]))
    # Inherited from a generic base: Derived::Add(string) is Base<string>.Add(!0).
    derived = image.type_ref("netstandard", "System", "Derived")
    image.member_ref(check.TYPEREF, derived, "Add", method_sig(bytes([VOID]), bytes([STRING])))
    if token_from is not None:
        # Api.Accept is declared over A's Token; B declares a Token with the same full name.
        api = image.type_ref("A", "Contracts", "Api")
        token = image.type_ref(token_from, "Contracts", "Token")
        image.member_ref(check.TYPEREF, api, "Accept", method_sig(bytes([VOID]), class_of(check.TYPEREF, token)))
    if rank_one_split:
        # char[*], a rank-one multi-dimensional array: not the vector char[].
        image.member_ref(check.TYPEREF, string, "Split", method_sig(bytes([SZARRAY, STRING]), bytes([0x14, CHAR, 1, 0, 0])))
    if bad_inherited:
        image.member_ref(check.TYPEREF, derived, "Add", method_sig(bytes([VOID]), bytes([I4])))
    if bad_split:
        image.member_ref(
            check.TYPEREF,
            string,
            "Split",
            method_sig(bytes([SZARRAY, STRING]), bytes([CHAR]), class_of(check.TYPEREF, options, VALUETYPE)),
        )
    if missing_type:
        image.type_ref("netstandard", "System", "HashCode")
    if missing_member:
        image.member_ref(check.TYPEREF, obj, ".ctor", method_sig(bytes([VOID]), bytes([I4])))
    if host_ref:
        image.type_ref("System.Private.CoreLib", "System", "Object")
    return image.build()


def run(*args: str) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = check.main(list(args))
    return code, out.getvalue()


class MemberReferenceCheckTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.surface = self.dir / "surface"
        self.surface.mkdir()
        (self.surface / "netstandard.dll").write_bytes(netstandard())
        (self.surface / "System.Runtime.dll").write_bytes(system_runtime_facade())
        (self.surface / "A.dll").write_bytes(contracts("A", with_api=True))
        (self.surface / "B.dll").write_bytes(contracts("B", with_api=False))

    def write(self, name: str, data: bytes) -> Path:
        path = self.dir / name
        path.write_bytes(data)
        return path

    def check(self, *paths: Path) -> tuple[int, str]:
        return run("--surface", str(self.surface), *(str(p) for p in paths))

    def nupkg(self, name: str, entries: dict[str, bytes]) -> Path:
        path = self.dir / name
        with zipfile.ZipFile(path, "w") as package:
            for entry, data in entries.items():
                package.writestr(entry, data)
        return path

    def test_references_that_resolve_pass(self) -> None:
        code, out = self.check(self.write("Good.dll", checked_image()))
        self.assertEqual(code, 0, out)
        # Anti-vacuity: every MemberRef of the good image was really looked up.
        self.assertIn("ok: 1 assembly(ies)", out)

    def test_split_char_string_split_options_on_netstandard_fails(self) -> None:
        code, out = self.check(self.write("Bad.dll", checked_image(bad_split=True)))
        self.assertEqual(code, 1, out)
        self.assertIn("[netstandard]System.String::Split(char, [netstandard]System.StringSplitOptions) : string[]", out)
        self.assertEqual(out.count("does not exist"), 1, out)

    def test_same_named_type_from_another_assembly_does_not_match(self) -> None:
        code, out = self.check(self.write("Same.dll", checked_image(token_from="A")))
        self.assertEqual(code, 0, out)
        code, out = self.check(self.write("Other.dll", checked_image(token_from="B")))
        self.assertEqual(code, 1, out)
        self.assertIn("[A]Contracts.Api::Accept([B]Contracts.Token) : void", out)

    def test_rank_one_array_is_not_the_vector_array(self) -> None:
        code, out = self.check(self.write("Rank.dll", checked_image(rank_one_split=True)))
        self.assertEqual(code, 1, out)
        self.assertIn("System.String::Split(char[*]) : string[]", out)

    def test_member_inherited_from_a_generic_base_reads_with_its_arguments(self) -> None:
        # The default image's Derived::Add(string) resolves (asserted by the passing case);
        # Add(int) does not exist on Base<string>.
        code, out = self.check(self.write("Inherited.dll", checked_image(bad_inherited=True)))
        self.assertEqual(code, 1, out)
        self.assertIn("[netstandard]System.Derived::Add(int) : void", out)
        self.assertEqual(out.count("does not exist"), 1, out)

    def test_type_the_surface_does_not_declare_fails(self) -> None:
        code, out = self.check(self.write("Missing.dll", checked_image(missing_type=True)))
        self.assertEqual(code, 1, out)
        self.assertIn("TypeRef [netstandard]System.HashCode is not declared", out)

    def test_constructor_is_not_found_on_a_base_type(self) -> None:
        # Object(int) does not exist; constructors are never inherited.
        code, out = self.check(self.write("Ctor.dll", checked_image(missing_member=True)))
        self.assertEqual(code, 1, out)
        self.assertIn("System.Object::.ctor(int) : void", out)

    def test_reference_to_an_assembly_off_the_surface_fails(self) -> None:
        code, out = self.check(self.write("Host.dll", checked_image(host_ref=True)))
        self.assertEqual(code, 1, out)
        self.assertIn("'System.Private.CoreLib', which is not on the reference surface", out)

    def test_task_and_lib_entries_inside_nupkg_are_checked(self) -> None:
        good = self.nupkg("Good.nupkg", {"tools/task/T.dll": checked_image(), "ref/netstandard2.0/T.dll": checked_image()})
        code, out = self.check(good)
        self.assertEqual(code, 0, out)
        self.assertIn("ok: 2 assembly(ies)", out)
        bad = self.nupkg("Bad.nupkg", {"lib/netstandard2.0/L.dll": checked_image(bad_split=True)})
        code, out = self.check(bad)
        self.assertEqual(code, 1, out)
        self.assertIn("Bad.nupkg!lib/netstandard2.0/L.dll", out)

    def test_modern_tfm_assembly_is_not_in_scope(self) -> None:
        package = self.nupkg("Modern.nupkg", {"lib/net10.0/L.dll": checked_image(bad_split=True), "tools/task/T.dll": checked_image()})
        self.assertEqual(self.check(package)[0], 0)

    def test_package_without_in_scope_assemblies_fails_closed(self) -> None:
        package = self.nupkg("Empty.nupkg", {"lib/net10.0/L.dll": checked_image()})
        self.assertEqual(self.check(package)[0], 2)

    def test_surface_without_netstandard_is_refused(self) -> None:
        (self.surface / "netstandard.dll").unlink()
        code, out = self.check(self.write("Good.dll", checked_image()))
        self.assertEqual(code, 2, out)
        self.assertIn("no netstandard assembly", out)

    def test_missing_surface_directory_is_refused(self) -> None:
        code, out = run("--surface", str(self.dir / "nope"), str(self.write("Good.dll", checked_image())))
        self.assertEqual(code, 2, out)

    def test_default_surface_comes_from_the_locked_package_versions(self) -> None:
        lock = check.json.loads(check.LOCK_FILE.read_text(encoding="utf-8-sig"))["dependencies"][".NETStandard,Version=v2.0"]
        root = self.dir / "packages"
        for package, folder in check.DEFAULT_SURFACE_PACKAGES:
            target = root / package.lower() / lock[package]["resolved"] / folder
            target.mkdir(parents=True)
            if package == "NETStandard.Library":
                (target / "netstandard.dll").write_bytes(netstandard())
                (target / "System.Runtime.dll").write_bytes(system_runtime_facade())
            else:
                (target / f"{package}.dll").write_bytes(Image(package).build())
        with mock.patch.dict(os.environ, {"NUGET_PACKAGES": str(root)}):
            self.assertEqual(run(str(self.write("Good.dll", checked_image())))[0], 0)
            self.assertEqual(run(str(self.write("Bad.dll", checked_image(bad_split=True))))[0], 1)
        with mock.patch.dict(os.environ, {"NUGET_PACKAGES": str(self.dir / "empty")}):
            self.assertEqual(run(str(self.write("Good.dll", checked_image())))[0], 2)

    def test_non_managed_file_fails(self) -> None:
        code, out = self.check(self.write("Junk.dll", b"not a pe"))
        self.assertEqual(code, 1)
        self.assertIn("cannot read metadata", out)

    def test_missing_file_fails(self) -> None:
        self.assertEqual(self.check(self.dir / "nope.dll")[0], 1)


if __name__ == "__main__":
    unittest.main()
