package Oahu.Decrypt.Mpeg4.Boxes

import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class FrmaBox : Box {
    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        DataFormat = file.ReadType()
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(4)

    prop DataFormat string {
        get;
        init;
    }

    protected open override func Render(file Stream) {
        file.WriteType(DataFormat)
    }
}
