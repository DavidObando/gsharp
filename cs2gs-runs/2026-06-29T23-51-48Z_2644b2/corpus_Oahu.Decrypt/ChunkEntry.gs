package Oahu.Decrypt.Mpeg4.Chunks

class ChunkEntry {
    prop TrackId uint32 {
        get;
        init;
    }

    prop ChunkIndex uint32 {
        get;
        init;
    }

    prop ChunkOffset int64 {
        get;
        init;
    }

    prop FirstSample int64 {
        get;
        init;
    }

    prop ChunkSize int32 {
        get;
        init;
    }

    prop FrameSizes []int32 {
        get;
        init;
    }

    prop FrameDurations []uint32 {
        get;
        init;
    }

    prop ExtraData object? {
        get;
        init;
    }
}
