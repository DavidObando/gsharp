package Oahu.Decrypt.Mpeg4.Boxes

import System.IO

open class MoofBox : Box {
    init(file Stream, header BoxHeader) : base(header, nil) {
        LoadChildren(file)
    }

    prop Mfhd MfhdBox -> GetChildOrThrow[MfhdBox]()
    prop Traf TrafBox -> GetChildOrThrow[TrafBox]()

    protected open override func Render(file Stream) {
        return
    }
}
