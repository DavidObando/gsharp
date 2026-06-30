package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.IO
import Oahu.Decrypt.Mpeg4.Util

internal open class Co64Box : FullBox, IChunkOffsets {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        let entryCount = file.ReadUInt32BE()
        if entryCount > uint32(Int32.MaxValue) {
            throw NotSupportedException("Oahu.Decrypt.Mpeg4 does not support MPEG-4 files with more than ${Int32.MaxValue} chunk offsets")
        }
        ChunkOffsets = ChunkOffsetList.Read64(file, entryCount)
    }

    private init(chunkOffsets ChunkOffsetList, versionFlags []uint8, header BoxHeader, parent IBox) : base(versionFlags, header, parent) {
        ChunkOffsets = chunkOffsets
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(4) + int64(ChunkOffsets.Count * 8)
    prop EntryCount uint32 -> uint32(ChunkOffsets.Count)

    prop ChunkOffsets ChunkOffsetList {
        get;
        init;
    }

    protected open override func Render(file Stream) {
        base.Render(file)
        file.WriteUInt32BE(EntryCount)
        ChunkOffsets.Write64(file)
    }

    protected open override func Dispose(disposing bool) {
        if disposing && !Disposed {
            ChunkOffsets.Clear()
        }
        base.Dispose(disposing)
    }

    shared {
        internal func CreateBlank(parent IBox, chunkOffsets ChunkOffsetList) Co64Box {
            let size = 4 + 12
            let header = BoxHeader(uint32(size), "co64")
            chunkOffsets.Sort()
            let co64Box = Co64Box(chunkOffsets, []uint8{uint8(0), uint8(0), uint8(0), uint8(0)}, header, parent)
            parent.Children.Add(co64Box)
            return co64Box
        }
    }
}
