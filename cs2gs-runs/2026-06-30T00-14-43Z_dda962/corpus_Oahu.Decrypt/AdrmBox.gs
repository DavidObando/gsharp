package Oahu.Decrypt.Mpeg4.Boxes

import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class AdrmBox : Box {
    private let beginBlob []uint8
    private let middleBlob []uint8
    private let endBlob []uint8

    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        beginBlob = file.ReadBlock(8)
        DrmBlob = file.ReadBlock(56)
        middleBlob = file.ReadBlock(4)
        Checksum = file.ReadBlock(20)
        let len = RemainingBoxLength(file)
        endBlob = file.ReadBlock(int32(len))
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(beginBlob.Length) + int64(DrmBlob.Length) + int64(middleBlob.Length) + int64(Checksum.Length) + int64(endBlob.Length)

    prop DrmBlob []uint8 {
        get;
        init;
    }

    prop Checksum []uint8 {
        get;
        init;
    }

    protected open override func Render(file Stream) {
        file.Write(beginBlob)
        file.Write(DrmBlob)
        file.Write(middleBlob)
        file.Write(Checksum)
        file.Write(endBlob)
    }
}
