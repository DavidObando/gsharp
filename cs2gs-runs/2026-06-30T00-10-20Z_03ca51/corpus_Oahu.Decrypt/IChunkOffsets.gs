package Oahu.Decrypt.Mpeg4.Boxes

interface IChunkOffsets : IBox {
    prop EntryCount uint32 {
        get;
    }

    prop ChunkOffsets ChunkOffsetList {
        get;
    }

    shared {
        func Create(stbl StblBox, offsets ChunkOffsetList) IChunkOffsets {
            if offsets.Count == 0 {
                return StcoBox.CreateBlank(stbl, offsets)
            }
            offsets.Sort()
            let maxOffset = offsets.GetOffsetAtIndex(offsets.Count - 1)
            return if maxOffset > int64(UInt32.MaxValue) { Co64Box.CreateBlank(stbl, offsets) } else { StcoBox.CreateBlank(stbl, offsets) }
        }
    }
}
