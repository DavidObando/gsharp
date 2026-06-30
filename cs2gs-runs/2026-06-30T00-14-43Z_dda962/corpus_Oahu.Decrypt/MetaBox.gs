package Oahu.Decrypt.Mpeg4.Boxes

import System.IO

class MetaBox : FullBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        LoadChildren(file)
    }

    private init(parent IBox) : base([]uint8{uint8(0), uint8(0), uint8(0), uint8(0)}, BoxHeader(8, "meta"), parent) {
    }

    shared {
        func CreateEmpty(parent IBox) MetaBox {
            let meta = MetaBox(parent)
            parent.Children.Add(meta!!)
            return meta!!
        }
    }
}
