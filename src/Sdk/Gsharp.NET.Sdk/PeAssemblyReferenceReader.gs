// <copyright file="PeAssemblyReferenceReader.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.NET.Sdk.Tools

import System
import System.Collections.Generic
import System.IO
import System.Text

/// Minimal ECMA-335 PE/CLI metadata reader that extracts `Assembly` (table
/// `0x20`) and `AssemblyRef` (table `0x23`) simple names without taking a
/// `System.Reflection.Metadata` package dependency in the `netstandard2.0`
/// MSBuild task assembly.
internal shared class PeAssemblyReferenceReader {
    private const AssemblyTable int32 = 0x20
    private const AssemblyRefTable int32 = 0x23

    private sealed class MetadataLayout {
        internal let StringsOffset int32
        internal let StringsSize int32
        internal let TablesStart int32
        internal let Rows List[int32]
        internal let StringWidth int32
        internal let GuidWidth int32
        internal let BlobWidth int32

        internal init(
            stringsOffset int32,
            stringsSize int32,
            tablesStart int32,
            rows List[int32],
            stringWidth int32,
            guidWidth int32,
            blobWidth int32
        ) {
            this.StringsOffset = stringsOffset
            this.StringsSize = stringsSize
            this.TablesStart = tablesStart
            this.Rows = rows
            this.StringWidth = stringWidth
            this.GuidWidth = guidWidth
            this.BlobWidth = blobWidth
        }
    }

    /// Reads the `Name` column of row 0 in the `Assembly` table (`0x20`) of a
    /// managed PE file, or `nil` if the image has no CLI metadata or no
    /// `Assembly` row.
    internal func ReadAssemblySimpleName(assemblyPath string) string? {
        let data = File.ReadAllBytes(assemblyPath)
        return ReadAssemblySimpleName(data)
    }

    internal func ReadAssemblySimpleName(data[]uint8) string? {
        let layout = ReadMetadataLayout(data)
        if layout == nil || layout.Rows[AssemblyTable] <= 0 {
            return nil
        }

        let cursor = AdvanceToTable(layout, AssemblyTable)
        // Assembly row (ECMA-335 II.22.2):
        // HashAlgId(4), MajorVersion(2), MinorVersion(2), BuildNumber(2),
        // RevisionNumber(2), Flags(4), PublicKey(B), Name(S), Culture(S).
        let rowSize = 16 + layout.BlobWidth + 2 * layout.StringWidth
        if cursor < 0 || cursor + rowSize > data.Length {
            throw InvalidDataException("Assembly table extends past end of image.")
        }

        let nameFieldOffset = cursor + 16 + layout.BlobWidth
        let stringIndex = ReadStringIndex(data, nameFieldOffset, layout.StringWidth)
        return ReadMetadataString(data, layout.StringsOffset, layout.StringsSize, stringIndex)
    }

    /// Reads the `Name` column of every row in the `AssemblyRef` table of a
    /// managed PE file.
    internal func ReadAssemblyReferenceNames(assemblyPath string)[]string {
        let data = File.ReadAllBytes(assemblyPath)
        return ReadAssemblyReferenceNames(data)
    }

    internal func ReadAssemblyReferenceNames(data[]uint8)[]string {
        let layout = ReadMetadataLayout(data)
        if layout == nil {
            return Array.Empty[string]()!!
        }

        let assemblyRefCount = layout.Rows[AssemblyRefTable]
        if assemblyRefCount <= 0 {
            return Array.Empty[string]()!!
        }

        var cursor = AdvanceToTable(layout, AssemblyRefTable)

        // AssemblyRef row (ECMA-335 II.22.5):
        // MajorVersion(2), MinorVersion(2), BuildNumber(2), RevisionNumber(2),
        // Flags(4), PublicKeyOrToken(B), Name(S), Culture(S), HashValue(B).
        let rowSize = 12 + layout.BlobWidth + 2 * layout.StringWidth + layout.BlobWidth
        if cursor < 0 || cursor + assemblyRefCount * rowSize > data.Length {
            throw InvalidDataException("AssemblyRef table extends past end of image.")
        }

        let names = List[string](assemblyRefCount)
        for var i = 0; i < assemblyRefCount; i++ {
            let nameFieldOffset = cursor + 12 + layout.BlobWidth
            let stringIndex = ReadStringIndex(data, nameFieldOffset, layout.StringWidth)
            names.Add(ReadMetadataString(data, layout.StringsOffset, layout.StringsSize, stringIndex))
            cursor += rowSize
        }
        return names.ToArray()
    }

    private func ReadMetadataLayout(data[]uint8) MetadataLayout? {
        if data.Length < 0x40 || data[0] != 0x4D || data[1] != 0x5A {
            throw InvalidDataException("Not a PE image.")
        }
        let peOffset = ReadInt32(data, 0x3C)
        if peOffset < 0 ||
            peOffset +
            24 > data.Length ||
            data[peOffset] != 0x50 ||
            data[peOffset + 1] != 0x45 ||
            data[peOffset + 2] != 0 ||
            data[peOffset + 3] != 0 {
            throw InvalidDataException("Invalid PE signature.")
        }
        let sectionCount = cast[int32](ReadUInt16(data, peOffset + 6))
        let optionalHeaderSize = cast[int32](ReadUInt16(data, peOffset + 20))
        let optionalOffset = peOffset + 24
        if optionalOffset + optionalHeaderSize > data.Length || optionalHeaderSize < 2 {
            throw InvalidDataException("Truncated PE optional header.")
        }
        let magic = ReadUInt16(data, optionalOffset)
        var dataDirsOffset int32
        if magic == 0x10B {
            dataDirsOffset = optionalOffset + 96
        } else if magic == 0x20B {
            dataDirsOffset = optionalOffset + 112
        } else {
            throw InvalidDataException("Unsupported PE optional header magic.")
        }
        let cliDirOffset = dataDirsOffset + 14 * 8
        if cliDirOffset + 8 > data.Length {
            throw InvalidDataException("Missing CLI header directory entry.")
        }
        let cliRva = ReadUInt32(data, cliDirOffset)
        if cliRva == 0 {
            return nil
        }
        let sectionsOffset = optionalOffset + optionalHeaderSize
        let cliOffset = RvaToOffset(data, sectionsOffset, sectionCount, cliRva)
        if cliOffset + 16 > data.Length {
            throw InvalidDataException("Truncated CLI header.")
        }
        let metadataRva = ReadUInt32(data, cliOffset + 8)
        let metadataOffset = RvaToOffset(data, sectionsOffset, sectionCount, metadataRva)
        if metadataOffset + 16 > data.Length || ReadUInt32(data, metadataOffset) != 0x424A5342 {
            throw InvalidDataException("Invalid CLI metadata signature.")
        }
        let versionLength = ReadInt32(data, metadataOffset + 12)
        var pos = metadataOffset + 16 + versionLength + 2
        if pos + 2 > data.Length {
            throw InvalidDataException("Truncated CLI metadata header.")
        }
        let streamCount = cast[int32](ReadUInt16(data, pos))
        pos += 2

        var stringsOffset = -1
        var stringsSize = 0
        var tablesOffset = -1
        for var i = 0; i < streamCount; i++ {
            if pos + 8 > data.Length {
                throw InvalidDataException("Truncated CLI stream header.")
            }
            let streamRelOffset = ReadInt32(data, pos)
            let streamSize = ReadInt32(data, pos + 4)
            pos += 8
            let nameStart = pos
            while pos < data.Length && data[pos] != 0 {
                pos += 1
            }
            if pos >= data.Length {
                throw InvalidDataException("Unterminated CLI stream name.")
            }
            let streamName = Encoding.ASCII.GetString(data, nameStart, pos - nameStart)
            pos = (pos + 4) & ~3
            if streamName == "#Strings" {
                stringsOffset = metadataOffset + streamRelOffset
                stringsSize = streamSize
            } else if streamName == "#~" || streamName == "#-" {
                tablesOffset = metadataOffset + streamRelOffset
            }
        }
        if stringsOffset < 0 || tablesOffset < 0 || tablesOffset + 24 > data.Length {
            throw InvalidDataException("Missing #Strings or metadata table stream.")
        }

        let heapSizes = data[tablesOffset + 6]
        let stringWidth = if (heapSizes & 1) != 0 {
            4
        } else {
            2
        }
        let guidWidth = if (heapSizes & 2) != 0 {
            4
        } else {
            2
        }
        let blobWidth = if (heapSizes & 4) != 0 {
            4
        } else {
            2
        }
        let validMask = ReadUInt64(data, tablesOffset + 8)

        var cursor = tablesOffset + 24
        let rows = List[int32](64)
        for var table = 0; table < 64; table++ {
            if ((validMask >> table) & 1UL) != 0UL {
                if cursor + 4 > data.Length {
                    throw InvalidDataException("Truncated metadata row counts.")
                }
                rows.Add(ReadInt32(data, cursor))
                cursor += 4
            } else {
                rows.Add(0)
            }
        }
        if (heapSizes & 0x40) != 0 {
            cursor += 4
        }

        return MetadataLayout(stringsOffset, stringsSize, cursor, rows, stringWidth, guidWidth, blobWidth)
    }

    private func AdvanceToTable(layout MetadataLayout, targetTable int32) int32 {
        var cursor = layout.TablesStart
        for var table = 0; table < targetTable; table++ {
            let count = layout.Rows[table]
            if count > 0 {
                let rowSize = GetTableRowSize(
                    table,
                    layout.Rows,
                    layout.StringWidth,
                    layout.GuidWidth,
                    layout.BlobWidth
                )
                cursor += count * rowSize
            }
        }
        return cursor
    }

    private func ReadStringIndex(data[]uint8, offset int32, stringWidth int32) int32 -> if stringWidth == 4 {
        ReadInt32(data, offset)
    } else {
        cast[int32](ReadUInt16(data, offset))
    }

    private func ReadMetadataString(data[]uint8, stringsOffset int32, stringsSize int32, stringIndex int32) string {
        if stringIndex < 0 || stringIndex >= stringsSize {
            throw InvalidDataException("Metadata Name index outside #Strings heap.")
        }
        let begin = stringsOffset + stringIndex
        var end = begin
        let limit = stringsOffset + stringsSize
        while end < limit && end < data.Length && data[end] != 0 {
            end += 1
        }
        return Encoding.UTF8.GetString(data, begin, end - begin)
    }

    private func RvaToOffset(data[]uint8, sectionsOffset int32, sectionCount int32, rva uint32) int32 {
        for var i = 0; i < sectionCount; i++ {
            let entry = sectionsOffset + i * 40
            if entry + 40 > data.Length {
                throw InvalidDataException("Truncated PE section header.")
            }
            let virtualSize = ReadUInt32(data, entry + 8)
            let virtualAddress = ReadUInt32(data, entry + 12)
            let rawSize = ReadUInt32(data, entry + 16)
            let rawPointer = ReadUInt32(data, entry + 20)
            let span = if virtualSize > rawSize {
                virtualSize
            } else {
                rawSize
            }
            if rva >= virtualAddress && rva < virtualAddress + span {
                return cast[int32](rawPointer + (rva - virtualAddress))
            }
        }
        throw InvalidDataException("PE RVA falls outside all sections.")
    }

    private func TableIndexWidth(rows List[int32], table int32) int32 -> if rows[table] > 0xFFFF {
        4
    } else {
        2
    }

    private func CodedIndexWidth(rows List[int32], tagBits int32, targets[]int32) int32 {
        var maxRows = 0
        for t in targets {
            if t >= 0 && rows[t] > maxRows {
                maxRows = rows[t]
            }
        }
        let threshold = 1 << (16 - tagBits)
        return if maxRows >= threshold {
            4
        } else {
            2
        }
    }

    private func GetTableRowSize(table int32, rows List[int32], s int32, g int32, b int32) int32 {
        let typeDefOrRef = CodedIndexWidth(rows, 2, []int32{0x02, 0x01, 0x1B})
        let hasConstant = CodedIndexWidth(rows, 2, []int32{0x04, 0x08, 0x17})
        let hasCustomAttribute = CodedIndexWidth(
            rows,
            5,
            []int32{
                0x06,
                0x04,
                0x01,
                0x02,
                0x08,
                0x09,
                0x0A,
                0x00,
                0x0E,
                0x17,
                0x14,
                0x11,
                0x1A,
                0x1B,
                0x20,
                0x23,
                0x26,
                0x27,
                0x28,
                0x2A,
                0x2C,
                0x2B
            }
        )
        let customAttributeType = CodedIndexWidth(rows, 3, []int32{-1, -1, 0x06, 0x0A, -1})
        let hasFieldMarshal = CodedIndexWidth(rows, 1, []int32{0x04, 0x08})
        let hasDeclSecurity = CodedIndexWidth(rows, 2, []int32{0x02, 0x06, 0x20})
        let memberRefParent = CodedIndexWidth(rows, 3, []int32{0x02, 0x01, 0x1A, 0x06, 0x1B})
        let hasSemantics = CodedIndexWidth(rows, 1, []int32{0x14, 0x17})
        let methodDefOrRef = CodedIndexWidth(rows, 1, []int32{0x06, 0x0A})
        let memberForwarded = CodedIndexWidth(rows, 1, []int32{0x04, 0x06})
        let resolutionScope = CodedIndexWidth(rows, 2, []int32{0x00, 0x1A, 0x23, 0x01})

        let size = switch table {
            case 0x00: 2 + s + g + g + g
            case 0x01: resolutionScope + s + s
            case 0x02: 4 + s + s + typeDefOrRef + TableIndexWidth(rows, 0x04) + TableIndexWidth(rows, 0x06)
            case 0x03: TableIndexWidth(rows, 0x04)
            case 0x04: 2 + s + b
            case 0x05: TableIndexWidth(rows, 0x06)
            case 0x06: 4 + 2 + 2 + s + b + TableIndexWidth(rows, 0x08)
            case 0x07: TableIndexWidth(rows, 0x08)
            case 0x08: 2 + 2 + s
            case 0x09: TableIndexWidth(rows, 0x02) + typeDefOrRef
            case 0x0A: memberRefParent + s + b
            case 0x0B: 2 + hasConstant + b
            case 0x0C: hasCustomAttribute + customAttributeType + b
            case 0x0D: hasFieldMarshal + b
            case 0x0E: 2 + hasDeclSecurity + b
            case 0x0F: 2 + 4 + TableIndexWidth(rows, 0x02)
            case 0x10: 4 + TableIndexWidth(rows, 0x04)
            case 0x11: b
            case 0x12: TableIndexWidth(rows, 0x02) + TableIndexWidth(rows, 0x14)
            case 0x13: TableIndexWidth(rows, 0x14)
            case 0x14: 2 + s + typeDefOrRef
            case 0x15: TableIndexWidth(rows, 0x02) + TableIndexWidth(rows, 0x17)
            case 0x16: TableIndexWidth(rows, 0x17)
            case 0x17: 2 + s + b
            case 0x18: 2 + TableIndexWidth(rows, 0x06) + hasSemantics
            case 0x19: TableIndexWidth(rows, 0x02) + methodDefOrRef + methodDefOrRef
            case 0x1A: s
            case 0x1B: b
            case 0x1C: 2 + memberForwarded + s + TableIndexWidth(rows, 0x1A)
            case 0x1D: 4 + TableIndexWidth(rows, 0x04)
            case 0x1E: 4 + 4
            case 0x1F: 4
            case 0x20: 4 + 2 + 2 + 2 + 2 + 4 + b + s + s
            case 0x21: 4
            case 0x22: 4 + 4 + 4
            default: -1
        }
        if size < 0 {
            throw InvalidDataException("Unsupported CLI metadata table 0x" + table.ToString("X2"))
        }
        return size
    }

    private func ReadUInt16(data[]uint8, offset int32) uint16 ->
    cast[uint16](cast[int32](data[offset]) | (cast[int32](data[offset + 1]) << 8))

    private func ReadUInt32(data[]uint8, offset int32) uint32 ->
    cast[uint32](data[offset]) |
    (cast[uint32](data[offset + 1]) << 8) |
    (cast[uint32](data[offset + 2]) << 16) |
    (cast[uint32](data[offset + 3]) << 24)

    private func ReadInt32(data[]uint8, offset int32) int32 -> cast[int32](ReadUInt32(data, offset))

    private func ReadUInt64(data[]uint8, offset int32) uint64 ->
    cast[uint64](ReadUInt32(data, offset)) | (cast[uint64](ReadUInt32(data, offset + 4)) << 32)
}
