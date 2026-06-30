package Oahu.Decrypt.Mpeg4.Boxes

import System.IO

open class UdtaBox : Box {
    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        LoadChildren(file)
    }

    private init(parent IBox) : base(BoxHeader(8, "udta"), parent) {
    }

    protected open override func Render(file Stream) {
        return
    }

    shared {
        func CreateEmpty(parent IBox) UdtaBox {
            let udata = UdtaBox(parent)
            parent.Children.Add(udata!!)
            return udata!!
        }
    }
}
