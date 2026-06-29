package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.Buffers.Binary
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Runtime.InteropServices
import Oahu.Decrypt.Mpeg4.Util

open class SttsBox : FullBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        Samples = List[SttsBox.SampleEntry]()
        let entryCount = file.ReadUInt32BE()
        Debug.Assert(entryCount <= uint32(Int32.MaxValue))
        Samples = List[SttsBox.SampleEntry](int32(entryCount))
        CollectionsMarshal.SetCount(Samples, int32(entryCount))
        let samples = CollectionsMarshal.AsSpan(Samples)
        file.ReadExactly(MemoryMarshal.AsBytes(samples))
        if BitConverter.IsLittleEndian {
            let uints = MemoryMarshal.Cast[SttsBox.SampleEntry, uint32](samples)
            BinaryPrimitives.ReverseEndianness(uints, uints)
        }
    }

    private init(versionFlags []uint8, header BoxHeader, parent IBox?) : base(versionFlags, header, parent) {
        Samples = List[SttsBox.SampleEntry]()
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(4) + int64(EntryCount * 2 * 4)
    prop EntryCount int32 -> Samples.Count

    prop Samples List[SttsBox.SampleEntry] {
        get;
        init;
    }

    prop SampleTimeCount uint32 -> uint32(Samples.Sum((s SttsBox.SampleEntry) -> s.FrameCount))

    func EnumerateFrameDeltas(startAt uint32 = 0) sequence[uint32] {
        var startAt = startAt
        for entry in Samples {
            while startAt < entry.FrameCount {
                yield entry.FrameDelta
                startAt++
            }
            startAt -= entry.FrameCount
        }
    }

    func FrameToTime(timeScale float64, frameIndex uint64) TimeSpan {
        var beginDelta uint64 = uint64(0)
        var workingIndex = frameIndex
        for entry in Samples {
            if workingIndex <= uint64(entry.FrameCount) {
                return TimeSpan.FromSeconds(float64((beginDelta + workingIndex * uint64(entry.FrameDelta))) / timeScale)
            }
            beginDelta += uint64(entry.FrameCount) * uint64(entry.FrameDelta)
            workingIndex -= uint64(entry.FrameCount)
        }
        throw IndexOutOfRangeException("${nameof(frameIndex)} $frameIndex is larger than the number of frames in ${nameof(SttsBox)}")
    }

    protected open override func Render(file Stream) {
        base.Render(file)
        file.WriteUInt32BE(uint32(Samples.Count))
        for sample in Samples {
            file.WriteUInt32BE(sample.FrameCount)
            file.WriteUInt32BE(sample.FrameDelta)
        }
    }

    protected open override func Dispose(disposing bool) {
        if disposing && !Disposed {
            Samples.Clear()
        }
        base.Dispose(disposing)
    }

    @StructLayout(0)
    data struct SampleEntry(FrameCount uint32, FrameDelta uint32) {
    }

    shared {
        func CreateBlank(parent IBox) SttsBox {
            let size = 4 + 12
            let header = BoxHeader(uint32(size), "stts")
            let sttsBox = SttsBox([]uint8{uint8(0), uint8(0), uint8(0), uint8(0)}, header, parent)
            parent.Children.Add(sttsBox)
            return sttsBox
        }
    }
}
