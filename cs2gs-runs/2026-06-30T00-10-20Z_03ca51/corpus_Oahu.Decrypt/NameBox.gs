package Oahu.Decrypt.Mpeg4.Boxes

import System.Diagnostics
import System.IO
import System.Text
import Oahu.Decrypt.Mpeg4.Util

@DebuggerDisplay("{DebuggerDisplay,nq}")
open class NameBox : FullBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        let stringSize = RemainingBoxLength(file)
        let stringData = file.ReadBlock(int32(stringSize))
        Name = Encoding.UTF8.GetString(stringData!!)
    }

    private init(header BoxHeader, parent IBox?, name string) : base([4]uint8, header, parent) {
        Name = name
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(Encoding.UTF8.GetByteCount(Name))
    prop Name string

    @DebuggerHidden
    private prop DebuggerDisplay string -> "name: $Name"

    protected open override func Render(file Stream) {
        base.Render(file)
        file.Write(Encoding.UTF8.GetBytes(Name))
    }

    shared {
        func Create(parent IBox?, name string) NameBox {
            let size = Encoding.UTF8.GetByteCount(name) + 12
            let header = BoxHeader(uint32(size), "name")
            let nameBox = NameBox(header, parent, name)
            parent?.Children.Add(nameBox)
            return nameBox
        }
    }
}
