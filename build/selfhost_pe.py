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
    enc_id_index_offset: int
    enc_base_id_index_offset: int
    pe_resource_directory_offset: int
    clr_resources_directory_offset: int


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

    string_index_size = 4 if heap_sizes & 0x01 else 2
    guid_index_size = 4 if heap_sizes & 0x02 else 2
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
    for start, end, label in (*directory_ranges, *clr_ranges):
        if max(mvid_offset, start) < min(mvid_end, end):
            raise PeError(f"Module.Mvid overlaps {label}")
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
        enc_id_index_offset=mvid_index_offset + guid_index_size,
        enc_base_id_index_offset=mvid_index_offset + 2 * guid_index_size,
        pe_resource_directory_offset=directories + 2 * 8,
        clr_resources_directory_offset=clr + 24,
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
