package Oahu.Decrypt.FrameFilters

import System
import Oahu.Decrypt.Mpeg4.Chunks

class FrameEntry {
    prop Chunk ChunkEntry? {
        get;
        init;
    }

    prop SamplesInFrame uint32 {
        get;
        init;
    }

    prop FrameData Memory[uint8] {
        get;
        init;
    }

    prop ExtraData object?
}
