package Oahu.Decrypt.Mpeg4.Boxes

import System.IO

open class TrakBox : Box {
    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        LoadChildren(file)
    }

    prop Tkhd TkhdBox -> GetChildOrThrow[TkhdBox]()
    prop Mdia MdiaBox -> GetChildOrThrow[MdiaBox]()

    protected open override func Render(file Stream) {
        return
    }
}
