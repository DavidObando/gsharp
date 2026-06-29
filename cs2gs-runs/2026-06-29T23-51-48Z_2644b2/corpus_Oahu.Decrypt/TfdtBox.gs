package Oahu.Decrypt.Mpeg4.Boxes

import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class TfdtBox : FullBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        BaseMediaDecodeTime = if Version == uint8(1) { file.ReadInt64BE() } else { int64(file.ReadUInt32BE()) }
    }

    open override prop RenderSize int64 -> base.RenderSize + int64((if Version == uint8(1) { 8 } else { 4 }))

    prop BaseMediaDecodeTime int64 {
        get;
        init;
    }

    protected open override func Render(file Stream) {
        base.Render(file)
        if Version == uint8(1) {
            file.WriteInt64BE(BaseMediaDecodeTime)
        } else {
            file.WriteUInt32BE(uint32(BaseMediaDecodeTime))
        }
    }
}
