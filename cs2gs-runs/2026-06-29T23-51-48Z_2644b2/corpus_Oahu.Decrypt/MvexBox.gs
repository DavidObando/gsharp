package Oahu.Decrypt.Mpeg4.Boxes

import System.IO

open class MvexBox : Box {
    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        LoadChildren(file)
    }

    protected open override func Render(file Stream) {
        return
    }
}
