package Oahu.Decrypt.Mpeg4.Boxes

import System.IO

open class StblBox : Box {
    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        LoadChildren(file)
    }

    prop Stsd StsdBox -> GetChildOrThrow[StsdBox]()
    prop Stts SttsBox -> GetChildOrThrow[SttsBox]()
    prop COBox IChunkOffsets -> GetChild[StcoBox]() ?? IChunkOffsets(GetChildOrThrow[Co64Box]())
    prop Stsz IStszBox? -> GetChild[StszBox]() ?? (GetChild[Stz2Box]() as IStszBox)
    prop Stsc StscBox -> GetChildOrThrow[StscBox]()

    protected open override func Render(file Stream) {
        return
    }
}
