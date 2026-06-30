package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.Diagnostics
import System.IO
import System.Text

@DebuggerDisplay("{DebuggerDisplay,nq}")
open class AppleTagBox : Box {
    init(file Stream, header BoxHeader, parent IBox) : base(header, parent) {
        LoadChildren(file)
    }

    protected init(header BoxHeader, parent IBox?) : base(header, parent) {
    }

    @DebuggerHidden
    open prop TagName string -> Header.Type

    prop Data AppleDataBox -> GetChildOrThrow[AppleDataBox]()
    private prop DebuggerDisplay string -> "[AppleTag]: $TagName"

    protected open override func Render(file Stream) {
        return
    }

    shared {
        func Create(parent AppleListBox, name string, data []uint8, dataType AppleDataType) AppleTagBox {
            if Encoding.ASCII.GetByteCount(name) != 4 {
                throw ArgumentOutOfRangeException(nameof(name), "${nameof(name)} must be exactly 4 bytes long")
            }
            let size = data.Length + 2 + 8
            let header = BoxHeader(uint32(size), name)
            let tagBox = AppleTagBox(header, parent)
            AppleDataBox.Create(tagBox, data, dataType)
            parent.Children.Add(tagBox)
            return tagBox
        }
    }
}
