package Oahu.Decrypt.Mpeg4.Boxes

import System.IO

open class MinfBox : Box {
    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        LoadChildren(file)
    }

    prop Stbl StblBox -> GetChildOrThrow[StblBox]()

    protected open override func Render(file Stream) {
        return
    }
}
