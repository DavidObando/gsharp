package Oahu.Decrypt.Mpeg4.Boxes

import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class MfhdBox : FullBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        SequenceNumber = file.ReadInt32BE()
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(4)

    prop SequenceNumber int32 {
        get;
        init;
    }

    protected open override func Render(file Stream) {
        base.Render(file)
        file.WriteInt32BE(SequenceNumber)
    }
}
