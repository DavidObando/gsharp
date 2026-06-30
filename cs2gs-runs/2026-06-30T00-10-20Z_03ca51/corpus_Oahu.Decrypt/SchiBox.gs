package Oahu.Decrypt.Mpeg4.Boxes

import System.IO

open class SchiBox : Box {
    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        LoadChildren(file)
    }

    prop TrackEncryption TencBox? -> GetChild[TencBox]()

    protected open override func Render(file Stream) {
        return
    }
}
