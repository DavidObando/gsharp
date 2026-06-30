package Oahu.Decrypt.Mpeg4.Boxes

import System.Diagnostics
import System.IO

@DebuggerDisplay("{DebuggerDisplay,nq}")
open class FreeformTagBox : AppleTagBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        LoadChildren(file)
    }

    protected init(header BoxHeader, parent IBox?) : base(header, parent) {
    }

    prop Mean MeanBox? -> GetChild[MeanBox]()
    prop Name NameBox? -> GetChild[NameBox]()
    open override prop TagName string -> "${Mean?.ReverseDnsDomain}:${Name?.Name}'"

    @DebuggerHidden
    private prop DebuggerDisplay string -> "----:$TagName"

    shared {
        func Create(parent AppleListBox?, domain string, tagName string, data []uint8, dataType AppleDataType) FreeformTagBox {
            let header = BoxHeader(8, "----")
            let tagBox = FreeformTagBox(header, parent)
            MeanBox.Create(tagBox!!, domain)
            NameBox.Create(tagBox!!, tagName)
            AppleDataBox.Create(tagBox!!, data, dataType)
            parent?.Children.Add(tagBox!!)
            return tagBox!!
        }
    }
}
