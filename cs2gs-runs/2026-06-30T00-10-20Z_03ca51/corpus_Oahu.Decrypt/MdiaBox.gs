package Oahu.Decrypt.Mpeg4.Boxes

import System.IO

open class MdiaBox : Box {
    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        LoadChildren(file)
    }

    prop Mdhd MdhdBox -> GetChildOrThrow[MdhdBox]()
    prop Hdlr HdlrBox -> GetChildOrThrow[HdlrBox]()
    prop Minf MinfBox -> GetChildOrThrow[MinfBox]()

    protected open override func Render(file Stream) {
        return
    }
}
