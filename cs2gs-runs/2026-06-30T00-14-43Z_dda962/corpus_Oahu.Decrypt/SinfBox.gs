package Oahu.Decrypt.Mpeg4.Boxes

import System.IO
import System.Linq

open class SinfBox : Box {
    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        LoadChildren(file)
    }

    prop OriginalFormat FrmaBox -> GetChildOrThrow[FrmaBox]()
    prop SchemeType SchmBox? -> GetChildren[SchmBox]()?.SingleOrDefault()
    prop SchemeInformation SchiBox? -> GetChildren[SchiBox]()?.SingleOrDefault()

    protected open override func Render(file Stream) {
        return
    }
}
