package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.Buffers.Binary
import System.Collections.Generic
import System.IO
import System.Linq
import System.Runtime.InteropServices
import Oahu.Decrypt.Mpeg4.Util

open class Stz2Box : FullBox, IStszBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        let reserved = stackalloc [4]uint8
        file.ReadExactly(reserved)
        FieldSize = reserved[3]
        let sampleCount = file.ReadUInt32BE()
        if !((FieldSize == 8 || FieldSize == 16)) {
            throw InvalidDataException("Stsz field size ($FieldSize). Valid values are 4, 8, or 16.")
        }
        if sampleCount > uint32(Int32.MaxValue) {
            throw NotSupportedException("Oahu.Decrypt.Mpeg4 does not support MPEG-4 files with more than ${Int32.MaxValue} samples")
        }
        SampleSizes = List[uint16](int32(sampleCount))
        CollectionsMarshal.SetCount(SampleSizes, int32(sampleCount))
        let shortSpan = CollectionsMarshal.AsSpan(SampleSizes)
        if FieldSize == 16 {
            file.ReadExactly(MemoryMarshal.AsBytes(shortSpan))
            if BitConverter.IsLittleEndian {
                BinaryPrimitives.ReverseEndianness(shortSpan, shortSpan)
            }
        } else {
            let bytes Span[uint8] = file.ReadBlock(int32(sampleCount))
            for var i = 0; int64(i) < int64(sampleCount); i++ {
                shortSpan[i] = bytes[i]
            }
        }
    }

    private init(versionFlags []uint8, header BoxHeader, parent IBox, sampleSizes List[uint16], fieldSize int32) : base(versionFlags, header, parent) {
        if fieldSize != 16 && fieldSize != 8 && fieldSize != 4 {
            throw InvalidDataException("Stsz field size ($fieldSize). Valid values are 4, 8, or 16.")
        }
        FieldSize = fieldSize
        SampleSizes = sampleSizes
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(8) + int64(SampleCount * FieldSize / 8) + int64((if FieldSize == 4 && SampleCount % 2 == 1 { 1 } else { 0 }))
    prop SampleCount int32 -> SampleSizes.Count

    prop SampleSizes List[uint16] {
        get;
        init;
    }

    prop MaxSize int32 -> SampleSizes.Max()
    prop TotalSize int64 -> SampleSizes.Sum((s uint16) -> int64(s))

    prop FieldSize int32 {
        get;
        init;
    }

    func GetSizeAtIndex(index int32) int32 -> SampleSizes[index]
    func SumFirstNSizes(firstN int32) int64 -> SampleSizes.Take(firstN).Sum((s uint16) -> int64(s))

    protected open override func Render(file Stream) {
        base.Render(file)
        let fieldSize = stackalloc [4]uint8
        let shortSpan = CollectionsMarshal.AsSpan(SampleSizes)
        fieldSize[3] = uint8((if shortSpan.AllLessThanOrEqual(uint16(Byte.MaxValue)) { 8 } else { 16 }))
        file.Write(fieldSize)
        file.WriteInt32BE(SampleSizes.Count)
        if fieldSize[3] == uint8(16) {
            if BitConverter.IsLittleEndian {
                BinaryPrimitives.ReverseEndianness(shortSpan, shortSpan)
            }
            file.Write(MemoryMarshal.AsBytes(shortSpan))
        } else {
            for size in SampleSizes {
                file.WriteByte(uint8(size))
            }
        }
    }

    shared {
        func CreateBlank(parent IBox, sampleSizes List[uint16]) Stz2Box {
            let size = 8 + 12
            let header = BoxHeader(uint32(size), "stz2")
            let stszBox = Stz2Box([]uint8{uint8(0), uint8(0), uint8(0), uint8(0)}, header, parent, sampleSizes, 16)
            parent.Children.Add(stszBox!!)
            return stszBox!!
        }
    }
}
