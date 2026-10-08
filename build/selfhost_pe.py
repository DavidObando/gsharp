#!/usr/bin/env python3
"""Fail-closed PE comparison for ADR-0198 stage-2 certification."""

from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass
from pathlib import Path


class PeError(ValueError):
    pass


@dataclass(frozen=True)
class PeFingerprint:
    path: str
    size: int
    raw_sha256: str
    normalized_sha256: str
    mvid_offset: int


@dataclass(frozen=True)
class PeLayout:
    mvid_offset: int
    mvid_rva: int
    mvid_index_offset: int
    guid_index_size: int
    guid_stream_offset: int
    guid_stream_size: int
    metadata_offset: int
    metadata_size: int
    module_row_count_offset: int
    type_def_row_count_offset: int
    tables_valid_offset: int
    metadata_rows_offset: int
    method_def_rows_offset: int
    method_def_row_size: int
    enc_id_index_offset: int
    enc_base_id_index_offset: int
    pe_resource_directory_offset: int
    clr_resources_directory_offset: int
    debug_directory_offset: int
    debug_directory_size: int
    field_rva_rows_offset: int
    field_rva_row_size: int
    method_data_section_offset: int
    optional_entrypoint_offset: int
    clr_flags_offset: int
    clr_entrypoint_offset: int


def _u16(data: bytes, offset: int) -> int:
    if offset < 0 or offset + 2 > len(data):
        raise PeError("truncated 16-bit PE field")
    return struct.unpack_from("<H", data, offset)[0]


def _u32(data: bytes, offset: int) -> int:
    if offset < 0 or offset + 4 > len(data):
        raise PeError("truncated 32-bit PE field")
    return struct.unpack_from("<I", data, offset)[0]


def _u64(data: bytes, offset: int) -> int:
    if offset < 0 or offset + 8 > len(data):
        raise PeError("truncated 64-bit metadata field")
    return struct.unpack_from("<Q", data, offset)[0]


def _range(start: int, size: int, limit: int, label: str) -> tuple[int, int]:
    if start < 0 or size < 0 or start > limit or size > limit - start:
        raise PeError(f"{label} is outside its containing image")
    return start, start + size


def inspect_layout(data: bytes) -> PeLayout:
    if len(data) < 0x40 or data[:2] != b"MZ":
        raise PeError("not a DOS/PE image")
    pe_offset = _u32(data, 0x3C)
    if pe_offset + 24 > len(data) or data[pe_offset:pe_offset + 4] != b"PE\0\0":
        raise PeError("invalid PE signature")

    coff = pe_offset + 4
    section_count = _u16(data, coff + 2)
    optional_size = _u16(data, coff + 16)
    optional = coff + 20
    _range(optional, optional_size, len(data), "optional header")
    magic = _u16(data, optional)
    if magic == 0x10B:
        directory_count_offset, directories = optional + 92, optional + 96
    elif magic == 0x20B:
        directory_count_offset, directories = optional + 108, optional + 112
    else:
        raise PeError("unsupported PE optional-header magic")
    directory_count = _u32(data, directory_count_offset)
    if directory_count <= 14 or directories + 15 * 8 > optional + optional_size:
        raise PeError("PE has no CLR data directory")

    sections_offset = optional + optional_size
    size_of_headers = _u32(data, optional + 60)
    _range(0, size_of_headers, len(data), "PE headers")
    _range(sections_offset, section_count * 40, len(data), "section table")
    sections: list[tuple[int, int, int, int]] = []
    raw_ranges: list[tuple[int, int]] = []
    for index in range(section_count):
        section = sections_offset + index * 40
        virtual_size = _u32(data, section + 8)
        virtual_address = _u32(data, section + 12)
        raw_size = _u32(data, section + 16)
        raw_offset = _u32(data, section + 20)
        raw = _range(raw_offset, raw_size, len(data), f"section {index} raw data")
        if raw_size and raw_offset < size_of_headers:
            raise PeError("PE section raw data overlaps PE headers")
        if any(max(raw[0], start) < min(raw[1], end) for start, end in raw_ranges):
            raise PeError("overlapping PE section raw ranges")
        raw_ranges.append(raw)
        sections.append((virtual_address, max(virtual_size, raw_size), raw_offset, raw_size))

    def rva_to_offset(rva: int, size: int, label: str) -> int:
        matches = []
        for virtual_address, span, raw_offset, raw_size in sections:
            if virtual_address <= rva and size <= span - (rva - virtual_address):
                delta = rva - virtual_address
                if delta <= raw_size and size <= raw_size - delta:
                    matches.append(raw_offset + delta)
        if len(matches) != 1:
            raise PeError(f"{label} maps to {len(matches)} PE sections")
        _range(matches[0], size, len(data), label)
        return matches[0]

    def offset_to_rva(offset: int, size: int, label: str) -> int:
        matches = []
        for virtual_address, _, raw_offset, raw_size in sections:
            if raw_offset <= offset and size <= raw_size - (offset - raw_offset):
                matches.append(virtual_address + offset - raw_offset)
        if len(matches) != 1:
            raise PeError(f"{label} maps to {len(matches)} PE sections")
        return matches[0]

    directory_ranges: list[tuple[int, int, str]] = []
    debug_directory_offset = 0
    debug_directory_size = 0
    available_directories = (optional + optional_size - directories) // 8
    if directory_count > available_directories:
        raise PeError("PE data-directory count exceeds the optional header")
    for index in range(directory_count):
        rva = _u32(data, directories + index * 8)
        size = _u32(data, directories + index * 8 + 4)
        if not rva or not size:
            continue
        if index == 4:
            start, end = _range(rva, size, len(data), "certificate directory")
        else:
            start = rva_to_offset(rva, size, f"PE data directory {index}")
            end = start + size
        directory_ranges.append((start, end, f"PE data directory {index}"))
        if index == 6:
            debug_directory_offset = start
            debug_directory_size = size

    debug_payload_ranges: list[tuple[int, int, str]] = []
    if debug_directory_size:
        if debug_directory_size % 28:
            raise PeError("truncated PE debug directory")
        for index in range(debug_directory_size // 28):
            entry = debug_directory_offset + index * 28
            size = _u32(data, entry + 16)
            payload_rva = _u32(data, entry + 20)
            payload_offset = _u32(data, entry + 24)
            if not size:
                continue
            start, end = _range(
                payload_offset, size, len(data), f"PE debug payload {index}")
            if payload_rva and rva_to_offset(
                    payload_rva, size, f"PE debug payload {index}") != start:
                raise PeError("PE debug payload RVA and file offset disagree")
            debug_payload_ranges.append(
                (start, end, f"PE debug payload {index}"))

    clr_rva = _u32(data, directories + 14 * 8)
    clr_size = _u32(data, directories + 14 * 8 + 4)
    if clr_size < 0x48:
        raise PeError("truncated CLR header")
    clr = rva_to_offset(clr_rva, clr_size, "CLR header")
    metadata_rva = _u32(data, clr + 8)
    metadata_size = _u32(data, clr + 12)
    metadata = rva_to_offset(metadata_rva, metadata_size, "CLR metadata")
    clr_ranges: list[tuple[int, int, str]] = []
    for field, label in (
        (24, "CLR managed resources"),
        (32, "CLR strong-name signature"),
        (40, "CLR code-manager table"),
        (48, "CLR vtable fixups"),
        (56, "CLR export-address jumps"),
        (64, "CLR managed-native header"),
    ):
        rva = _u32(data, clr + field)
        size = _u32(data, clr + field + 4)
        if not rva or not size:
            continue
        start = rva_to_offset(rva, size, label)
        clr_ranges.append((start, start + size, label))
    metadata_end = metadata + metadata_size
    if data[metadata:metadata + 4] != b"BSJB":
        raise PeError("invalid CLR metadata signature")

    version_length = _u32(data, metadata + 12)
    cursor = metadata + 16 + version_length
    _range(cursor, 4, metadata_end, "metadata stream header count")
    stream_count = _u16(data, cursor + 2)
    cursor += 4
    streams: dict[str, tuple[int, int]] = {}
    stream_ranges: list[tuple[int, int]] = []
    for _ in range(stream_count):
        _range(cursor, 8, metadata_end, "metadata stream header")
        relative = _u32(data, cursor)
        size = _u32(data, cursor + 4)
        cursor += 8
        name_end = data.find(b"\0", cursor, metadata_end)
        if name_end < 0:
            raise PeError("unterminated metadata stream name")
        try:
            name = data[cursor:name_end].decode("ascii")
        except UnicodeDecodeError as error:
            raise PeError("non-ASCII metadata stream name") from error
        cursor += ((name_end - cursor + 1 + 3) // 4) * 4
        start, end = _range(metadata + relative, size, metadata_end, f"{name} stream")
        if name in streams:
            raise PeError(f"duplicate {name} metadata stream")
        if any(max(start, other_start) < min(end, other_end)
               for other_start, other_end in stream_ranges):
            raise PeError("overlapping metadata streams")
        streams[name] = (start, size)
        stream_ranges.append((start, end))

    if any(start < cursor for start, _ in stream_ranges):
        raise PeError("metadata stream overlaps the metadata or stream headers")
    if "#GUID" not in streams:
        raise PeError("metadata has no #GUID stream")
    if "#Blob" not in streams:
        raise PeError("metadata has no #Blob stream")
    table_names = [name for name in ("#~", "#-") if name in streams]
    if len(table_names) != 1:
        raise PeError("metadata must have exactly one table stream")
    tables, tables_size = streams[table_names[0]]
    _range(tables, 24, tables + tables_size, "metadata tables header")
    heap_sizes = data[tables + 6]
    valid = _u64(data, tables + 8)
    row_cursor = tables + 24
    row_counts: dict[int, int] = {}
    row_count_offsets: dict[int, int] = {}
    for table in range(64):
        if valid & (1 << table):
            row_count_offsets[table] = row_cursor
            row_counts[table] = _u32(data, row_cursor)
            row_cursor += 4
    if row_counts.get(0) != 1:
        raise PeError("metadata must contain exactly one Module row")
    for table in (48, 55):
        if row_counts.get(table, 0):
            raise PeError(
                f"metadata table {table} has unsupported semantic GUID columns")

    string_index_size = 4 if heap_sizes & 0x01 else 2
    guid_index_size = 4 if heap_sizes & 0x02 else 2
    blob_index_size = 4 if heap_sizes & 0x04 else 2

    def table_index(table: int) -> int:
        return 4 if row_counts.get(table, 0) >= 0x10000 else 2

    def coded_index(tag_bits: int, tables_in_code: tuple[int, ...]) -> int:
        limit = 1 << (16 - tag_bits)
        return 4 if any(row_counts.get(table, 0) >= limit
                        for table in tables_in_code) else 2

    type_def_or_ref = coded_index(2, (2, 1, 27))
    has_constant = coded_index(2, (4, 8, 23))
    has_custom_attribute = coded_index(
        5, (6, 4, 1, 2, 8, 9, 10, 0, 14, 23, 20, 17, 26, 27, 32,
            35, 38, 39, 40, 42, 44, 43))
    has_field_marshal = coded_index(1, (4, 8))
    has_decl_security = coded_index(2, (2, 6, 32))
    member_ref_parent = coded_index(3, (2, 1, 26, 6, 27))
    has_semantics = coded_index(1, (20, 23))
    method_def_or_ref = coded_index(1, (6, 10))
    member_forwarded = coded_index(1, (4, 6))
    implementation = coded_index(2, (38, 35, 39))
    custom_attribute_type = coded_index(3, (6, 10))
    resolution_scope = coded_index(2, (0, 26, 35, 1))
    type_or_method_def = coded_index(1, (2, 6))
    has_custom_debug_information = coded_index(
        5, (6, 4, 1, 2, 8, 9, 10, 0, 14, 23, 20, 17, 26, 27, 32,
            35, 38, 39, 40, 42, 44, 43, 48, 50, 51, 52, 53))
    row_sizes = {
        0: 2 + string_index_size + 3 * guid_index_size,
        1: resolution_scope + 2 * string_index_size,
        2: 4 + 2 * string_index_size + type_def_or_ref
           + table_index(4) + table_index(6),
        3: table_index(4),
        4: 2 + string_index_size + blob_index_size,
        5: table_index(6),
        6: 8 + string_index_size + blob_index_size + table_index(8),
        7: table_index(8),
        8: 4 + string_index_size,
        9: table_index(2) + type_def_or_ref,
        10: member_ref_parent + string_index_size + blob_index_size,
        11: 2 + has_constant + blob_index_size,
        12: has_custom_attribute + custom_attribute_type + blob_index_size,
        13: has_field_marshal + blob_index_size,
        14: 2 + has_decl_security + blob_index_size,
        15: 6 + table_index(2),
        16: 4 + table_index(4),
        17: blob_index_size,
        18: table_index(2) + table_index(20),
        19: table_index(20),
        20: 2 + string_index_size + type_def_or_ref,
        21: table_index(2) + table_index(23),
        22: table_index(23),
        23: 2 + string_index_size + blob_index_size,
        24: 2 + table_index(6) + has_semantics,
        25: table_index(2) + 2 * method_def_or_ref,
        26: string_index_size,
        27: blob_index_size,
        28: 2 + member_forwarded + string_index_size + table_index(26),
        29: 4 + table_index(4),
        30: 8,
        31: 4,
        32: 16 + blob_index_size + 2 * string_index_size,
        33: 4,
        34: 12,
        35: 12 + 2 * blob_index_size + 2 * string_index_size,
        36: 4 + table_index(35),
        37: 12 + table_index(35),
        38: 4 + string_index_size + blob_index_size,
        39: 8 + 2 * string_index_size + implementation,
        40: 8 + string_index_size + implementation,
        41: 2 * table_index(2),
        42: 4 + type_or_method_def + string_index_size,
        43: method_def_or_ref + blob_index_size,
        44: table_index(42) + type_def_or_ref,
        48: blob_index_size + guid_index_size + blob_index_size + guid_index_size,
        49: table_index(48) + blob_index_size,
        50: table_index(6) + table_index(53) + table_index(51)
            + table_index(52) + 8,
        51: 4 + string_index_size,
        52: string_index_size + blob_index_size,
        53: table_index(53) + blob_index_size,
        54: 2 * table_index(6),
        55: has_custom_debug_information + guid_index_size + blob_index_size,
    }
    rows_end = row_cursor
    table_offsets: dict[int, int] = {}
    for table, count in row_counts.items():
        if table not in row_sizes:
            raise PeError(f"unsupported metadata table {table}")
        size = row_sizes[table] * count
        _range(rows_end, size, tables + tables_size, f"metadata table {table}")
        table_offsets[table] = rows_end
        rows_end += size
    if any(data[rows_end:tables + tables_size]):
        raise PeError("metadata table stream has nonzero trailing bytes")

    module_row_size = 2 + string_index_size + 3 * guid_index_size
    _range(row_cursor, module_row_size, tables + tables_size, "Module row")
    mvid_index_offset = row_cursor + 2 + string_index_size
    read_index = _u32 if guid_index_size == 4 else _u16
    mvid_index = read_index(data, mvid_index_offset)
    enc_id = read_index(data, mvid_index_offset + guid_index_size)
    enc_base_id = read_index(data, mvid_index_offset + 2 * guid_index_size)
    if mvid_index == 0:
        raise PeError("Module.Mvid has a zero GUID index")
    if mvid_index in (enc_id, enc_base_id):
        raise PeError("Module.Mvid aliases another semantic Module GUID")

    guid_start, guid_size = streams["#GUID"]
    if guid_size % 16:
        raise PeError("truncated #GUID stream")
    relative_mvid = (mvid_index - 1) * 16
    if relative_mvid < 0 or relative_mvid + 16 > guid_size:
        raise PeError("Module.Mvid is outside the #GUID stream")
    mvid_offset = guid_start + relative_mvid
    mvid_end = mvid_offset + 16
    for start, end, label in (
            *directory_ranges, *debug_payload_ranges, *clr_ranges):
        if max(mvid_offset, start) < min(mvid_end, end):
            raise PeError(f"Module.Mvid overlaps {label}")
    native_entrypoint_rva = _u32(data, optional + 16)
    if native_entrypoint_rva:
        start = rva_to_offset(native_entrypoint_rva, 1, "PE native entry point")
        if mvid_offset <= start < mvid_end:
            raise PeError("Module.Mvid aliases the PE native entry point")
    clr_flags = _u32(data, clr + 16)
    if clr_flags & 0x10:
        start = rva_to_offset(
            _u32(data, clr + 20), 1, "CLR native entry point")
        if mvid_offset <= start < mvid_end:
            raise PeError("Module.Mvid aliases the CLR native entry point")

    method_data_section_offset = 0

    def method_body_range(rva: int) -> tuple[int, int]:
        nonlocal method_data_section_offset
        start = rva_to_offset(rva, 1, "method body")
        first = data[start]
        if first & 0x03 == 0x02:
            end = start + 1 + (first >> 2)
        elif first & 0x03 == 0x03:
            flags = _u16(data, start)
            header_size = (flags >> 12) * 4
            if header_size < 12:
                raise PeError("invalid fat method header")
            code_size = _u32(data, start + 4)
            end = start + header_size + code_size
            _range(start, header_size + code_size, len(data), "method body")
            if flags & 0x08:
                cursor = (end + 3) & ~3
                if not method_data_section_offset:
                    method_data_section_offset = cursor
                while True:
                    _range(cursor, 2, len(data), "method data section")
                    kind = data[cursor]
                    if kind & 0x40:
                        _range(cursor, 4, len(data), "fat method data section")
                        size = int.from_bytes(data[cursor + 1:cursor + 4], "little")
                    else:
                        size = data[cursor + 1]
                    if size < 4:
                        raise PeError("invalid method data section size")
                    _range(cursor, size, len(data), "method data section")
                    end = cursor + size
                    if not kind & 0x80:
                        break
                    cursor = (end + 3) & ~3
        else:
            raise PeError("invalid method header")
        _range(start, end - start, len(data), "method body")
        return start, end

    method_rows = table_offsets.get(6, 0)
    method_row_size = row_sizes[6]
    for row in range(row_counts.get(6, 0)):
        rva = _u32(data, method_rows + row * method_row_size)
        if not rva:
            continue
        if mvid_offset <= rva_to_offset(rva, 1, "method body") < mvid_end:
            raise PeError("Module.Mvid overlaps a method body")
        start, end = method_body_range(rva)
        if max(mvid_offset, start) < min(mvid_end, end):
            raise PeError("Module.Mvid overlaps a method body")
    field_rva_rows = table_offsets.get(29, 0)
    field_rva_row_size = row_sizes[29]
    class_sizes: dict[int, int] = {}
    class_layout_rows = table_offsets.get(15, 0)
    for row in range(row_counts.get(15, 0)):
        entry = class_layout_rows + row * row_sizes[15]
        class_size = _u32(data, entry + 2)
        parent = (_u32 if table_index(2) == 4 else _u16)(data, entry + 6)
        if not parent or parent in class_sizes:
            raise PeError("invalid ClassLayout parent")
        class_sizes[parent] = class_size

    blob_start, blob_size = streams["#Blob"]

    def compressed_uint(offset: int, limit: int) -> tuple[int, int]:
        _range(offset, 1, limit, "compressed metadata integer")
        first = data[offset]
        if first < 0x80:
            return first, offset + 1
        if first < 0xC0:
            _range(offset, 2, limit, "compressed metadata integer")
            return ((first & 0x3F) << 8) | data[offset + 1], offset + 2
        if first < 0xE0:
            _range(offset, 4, limit, "compressed metadata integer")
            return (
                ((first & 0x1F) << 24)
                | (data[offset + 1] << 16)
                | (data[offset + 2] << 8)
                | data[offset + 3],
                offset + 4,
            )
        raise PeError("invalid compressed metadata integer")

    def field_data_size(field: int) -> int:
        if field < 1 or field > row_counts.get(4, 0):
            raise PeError("FieldRVA has an invalid Field index")
        entry = table_offsets[4] + (field - 1) * row_sizes[4]
        signature_index_offset = entry + 2 + string_index_size
        signature_index = (
            _u32 if blob_index_size == 4 else _u16)(
                data, signature_index_offset)
        if signature_index <= 0 or signature_index >= blob_size:
            raise PeError("FieldRVA field has an invalid signature")
        length, cursor = compressed_uint(
            blob_start + signature_index, blob_start + blob_size)
        end = cursor + length
        _range(cursor, length, blob_start + blob_size, "field signature")
        if cursor >= end or data[cursor] != 0x06:
            raise PeError("FieldRVA field has a non-field signature")
        cursor += 1
        while cursor < end and data[cursor] in (0x1F, 0x20):
            _, cursor = compressed_uint(cursor + 1, end)
        if cursor >= end:
            raise PeError("FieldRVA field has a truncated signature")
        element = data[cursor]
        cursor += 1
        primitive_sizes = {
            0x02: 1, 0x03: 2, 0x04: 1, 0x05: 1,
            0x06: 2, 0x07: 2, 0x08: 4, 0x09: 4,
            0x0A: 8, 0x0B: 8, 0x0C: 4, 0x0D: 8,
            0x18: 8 if magic == 0x20B else 4,
            0x19: 8 if magic == 0x20B else 4,
        }
        if element in primitive_sizes:
            size = primitive_sizes[element]
        elif element == 0x11:
            encoded, cursor = compressed_uint(cursor, end)
            if encoded & 0x03:
                raise PeError("FieldRVA value type is not a local TypeDef")
            size = class_sizes.get(encoded >> 2, 0)
            if not size:
                raise PeError("FieldRVA value type has no explicit size")
        else:
            raise PeError("unsupported FieldRVA field type")
        if cursor != end:
            raise PeError("FieldRVA field has trailing signature data")
        return size

    for row in range(row_counts.get(29, 0)):
        entry = field_rva_rows + row * field_rva_row_size
        rva = _u32(data, entry)
        if not rva:
            continue
        field = (_u32 if table_index(4) == 4 else _u16)(data, entry + 4)
        size = field_data_size(field)
        start = rva_to_offset(rva, size, "field RVA data")
        if max(mvid_offset, start) < min(mvid_end, start + size):
            raise PeError("Module.Mvid overlaps field RVA data")

    return PeLayout(
        mvid_offset=mvid_offset,
        mvid_rva=offset_to_rva(mvid_offset, 16, "Module.Mvid"),
        mvid_index_offset=mvid_index_offset,
        guid_index_size=guid_index_size,
        guid_stream_offset=guid_start,
        guid_stream_size=guid_size,
        metadata_offset=metadata,
        metadata_size=metadata_size,
        module_row_count_offset=row_count_offsets[0],
        type_def_row_count_offset=row_count_offsets.get(2, -1),
        tables_valid_offset=tables + 8,
        metadata_rows_offset=row_cursor,
        method_def_rows_offset=method_rows,
        method_def_row_size=method_row_size,
        enc_id_index_offset=mvid_index_offset + guid_index_size,
        enc_base_id_index_offset=mvid_index_offset + 2 * guid_index_size,
        pe_resource_directory_offset=directories + 2 * 8,
        clr_resources_directory_offset=clr + 24,
        debug_directory_offset=debug_directory_offset,
        debug_directory_size=debug_directory_size,
        field_rva_rows_offset=field_rva_rows,
        field_rva_row_size=field_rva_row_size,
        method_data_section_offset=method_data_section_offset,
        optional_entrypoint_offset=optional + 16,
        clr_flags_offset=clr + 16,
        clr_entrypoint_offset=clr + 20,
    )


def fingerprint(path: Path) -> PeFingerprint:
    data = path.read_bytes()
    mvid = inspect_layout(data).mvid_offset
    normalized = bytearray(data)
    normalized[mvid:mvid + 16] = bytes(16)
    return PeFingerprint(
        path=str(path),
        size=len(data),
        raw_sha256=hashlib.sha256(data).hexdigest(),
        normalized_sha256=hashlib.sha256(normalized).hexdigest(),
        mvid_offset=mvid,
    )


def compare(first: Path, second: Path) -> tuple[PeFingerprint, PeFingerprint, bool]:
    left = fingerprint(first)
    right = fingerprint(second)
    return left, right, (
        left.size == right.size
        and left.normalized_sha256 == right.normalized_sha256
    )
