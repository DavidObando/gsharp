package Oahu.Decrypt.Mpeg4.Boxes

import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class MehdBox : FullBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        FragmentDuration = if Version == uint8(1) { file.ReadUInt64BE() } else { uint64(file.ReadUInt32BE()) }
    }

    open override prop RenderSize int64 -> base.RenderSize + int64((if Version == uint8(1) { 8 } else { 4 }))

    prop FragmentDuration uint64 {
        get;
        init;
    }

    protected open override func Render(file Stream) {
        base.Render(file)
        if Version == uint8(1) {
            file.WriteUInt64BE(FragmentDuration)
        } else {
            file.WriteUInt32BE(uint32(FragmentDuration))
        }
    }
}
