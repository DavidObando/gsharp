package Oahu.Decrypt.Mpeg4.Boxes

import System.IO

open class TrafBox : Box {
    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        LoadChildren(file)
    }

    prop Tfhd TfhdBox -> GetChildOrThrow[TfhdBox]()
    prop Tfdt TfdtBox? -> GetChild[TfdtBox]()
    prop Trun TrunBox? -> GetChild[TrunBox]()
    prop Saiz SaizBox? -> GetChild[SaizBox]()
    prop Saio SaioBox? -> GetChild[SaioBox]()
    prop Senc SencBox? -> GetChild[SencBox]()

    protected open override func Render(file Stream) {
        return
    }
}
