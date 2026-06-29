package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.Buffers.Binary
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Runtime.InteropServices
import Oahu.Decrypt.Mpeg4.Util

struct ChunkFrames {
    prop FirstFrameIndex uint32 {
        get;
        init;
    }

    prop NumberOfFrames uint32 {
        get;
        init;
    }
}

open class StscBox : FullBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        let entryCount = file.ReadUInt32BE()
        Debug.Assert(entryCount <= uint32(Int32.MaxValue))
        Samples = List[StscChunkEntry](int32(entryCount))
        CollectionsMarshal.SetCount(Samples, int32(entryCount))
        let samples = CollectionsMarshal.AsSpan(Samples)
        file.ReadExactly(MemoryMarshal.AsBytes(samples))
        if BitConverter.IsLittleEndian {
            let uints = MemoryMarshal.Cast[StscChunkEntry, uint32](samples)
            BinaryPrimitives.ReverseEndianness(uints, uints)
        }
    }

    private init(versionFlags []uint8, header BoxHeader, parent IBox) : base(versionFlags, header, parent) {
        Samples = List[StscChunkEntry]()
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(4) + int64(EntryCount * 3 * 4)
    prop EntryCount int32 -> Samples.Count

    prop Samples List[StscChunkEntry] {
        get;
        init;
    }

    func CalculateChunkFrameTable(numChunks uint32) []ChunkFrames {
        let table = [int32(numChunks)]ChunkFrames
        var firstFrameIndex uint32 = uint32(0)
        var lastStscIndex = 0
        for var chunk uint32 = uint32(1); chunk <= numChunks; chunk++ {
            if lastStscIndex + 1 < Samples.Count && chunk == Samples[lastStscIndex + 1].FirstChunk {
                lastStscIndex++
            }
            table[chunk - uint32(1)] = ChunkFrames{FirstFrameIndex: firstFrameIndex, NumberOfFrames: Samples[lastStscIndex].SamplesPerChunk}
            firstFrameIndex += Samples[lastStscIndex].SamplesPerChunk
        }
        return table
    }

    protected open override func Render(file Stream) {
        base.Render(file)
        file.WriteUInt32BE(uint32(Samples.Count))
        for sample in Samples {
            file.WriteUInt32BE(sample.FirstChunk)
            file.WriteUInt32BE(sample.SamplesPerChunk)
            file.WriteUInt32BE(sample.SampleDescriptionIndex)
        }
    }

    protected open override func Dispose(disposing bool) {
        if disposing && !Disposed {
            Samples.Clear()
        }
        base.Dispose(disposing)
    }

    @StructLayout(0)
    data struct StscChunkEntry(FirstChunk uint32, SamplesPerChunk uint32, SampleDescriptionIndex uint32) {
    }

    shared {
        func CreateBlank(parent IBox) StscBox {
            let size = 4 + 12
            let header = BoxHeader(uint32(size), "stsc")
            let stscBox = StscBox([]uint8{uint8(0), uint8(0), uint8(0), uint8(0)}, header, parent)
            parent.Children.Add(stscBox)
            return stscBox
        }
    }
}
