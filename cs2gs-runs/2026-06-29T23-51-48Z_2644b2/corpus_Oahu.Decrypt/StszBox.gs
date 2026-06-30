package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.Buffers.Binary
import System.Collections.Generic
import System.IO
import System.Linq
import System.Runtime.InteropServices
import Oahu.Decrypt.Mpeg4.Util

open class StszBox : FullBox, IStszBox {
    private let origSampleCount int32
    private let sampleSizes32 List[int32]?
    private let sampleSizes16 List[uint16]?

    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        SampleSize = file.ReadInt32BE()
        let sampleCountU = file.ReadUInt32BE()
        if sampleCountU > uint32(Int32.MaxValue) {
            throw NotSupportedException("Oahu.Decrypt.Mpeg4 does not support MPEG-4 files with more than ${Int32.MaxValue} samples")
        }
        origSampleCount = int32(sampleCountU)
        if SampleSize > 0 {
            return
        }
        sampleSizes32 = List[int32](origSampleCount)
        CollectionsMarshal.SetCount(sampleSizes32!!, origSampleCount)
        let intListSpan = CollectionsMarshal.AsSpan(sampleSizes32!!)
        file.ReadExactly(MemoryMarshal.AsBytes(intListSpan))
        if BitConverter.IsLittleEndian {
            BinaryPrimitives.ReverseEndianness(intListSpan, intListSpan)
        }
        if intListSpan.AllLessThanOrEqual(int32(UInt16.MaxValue)) {
            sampleSizes16 = List[uint16](origSampleCount)
            CollectionsMarshal.SetCount(sampleSizes16!!, origSampleCount)
            let shortListSpan = CollectionsMarshal.AsSpan(sampleSizes16!!)
            for var i = 0; i < origSampleCount; i++ {
                shortListSpan[i] = uint16(intListSpan[i])
            }
            CollectionsMarshal.SetCount(sampleSizes32!!, 0)
            sampleSizes32 = nil
        }
    }

    private init(versionFlags []uint8, header BoxHeader, parent IBox, sampleSizes List[int32]) : base(versionFlags, header, parent) {
        sampleSizes32 = sampleSizes
    }

    private init(versionFlags []uint8, header BoxHeader, parent IBox, sampleSizes List[uint16]) : base(versionFlags, header, parent) {
        sampleSizes16 = sampleSizes
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(8) + int64(SampleCount * 4)

    prop SampleSize int32 {
        get;
        init;
    }

    prop SampleCount int32 -> sampleSizes32?.Count ?? sampleSizes16?.Count ?? origSampleCount
    prop MaxSize int32 -> sampleSizes32?.Max() ?? sampleSizes16?.Max() ?? uint16(SampleSize)
    prop TotalSize int64 -> sampleSizes32?.Sum((s int32) -> int64(s)) ?? sampleSizes16?.Sum((s uint16) -> int64(s)) ?? int64(SampleSize * origSampleCount)
    func GetSizeAtIndex(index int32) int32 -> sampleSizes32?[index] ?? sampleSizes16?[index] ?? uint16(SampleSize)
    func SumFirstNSizes(firstN int32) int64 -> sampleSizes32?.Take(firstN).Sum((s int32) -> int64(s)) ?? sampleSizes16?.Take(firstN).Sum((s uint16) -> int64(s)) ?? int64(SampleSize) * int64(firstN)

    protected open override func Render(file Stream) {
        unsafe {
            base.Render(file)
            file.WriteInt32BE(SampleSize)
            file.WriteUInt32BE(uint32(SampleCount))
            if sampleSizes32 != nil {
                let intSpan = CollectionsMarshal.AsSpan(sampleSizes32!!)
                if BitConverter.IsLittleEndian {
                    BinaryPrimitives.ReverseEndianness(intSpan, intSpan)
                }
                file.Write(MemoryMarshal.AsBytes(intSpan))
            } else if sampleSizes16 != nil {
                for size in sampleSizes16!! {
                    file.WriteInt32BE(size)
                }
            }
        }
    }

    shared {
        func CreateBlank(parent IBox, sampleSizes List[int32]) StszBox {
            let size = 8 + 12
            let header = BoxHeader(uint32(size), "stsz")
            let stszBox = StszBox([]uint8{uint8(0), uint8(0), uint8(0), uint8(0)}, header, parent, sampleSizes)
            parent.Children.Add(stszBox!!)
            return stszBox!!
        }

        func CreateBlank(parent IBox, sampleSizes List[uint16]) StszBox {
            let size = 8 + 12
            let header = BoxHeader(uint32(size), "stsz")
            let stszBox = StszBox([]uint8{uint8(0), uint8(0), uint8(0), uint8(0)}, header, parent, sampleSizes)
            parent.Children.Add(stszBox!!)
            return stszBox!!
        }
    }
}
