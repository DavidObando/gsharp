package Oahu.Decrypt.Mpeg4.Boxes

import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class UnknownBox : Box {
    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        Data = file.ReadBlock(int32((Header.TotalBoxSize - int64(header.HeaderSize))))
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(Data.Length)

    prop Data []uint8 {
        get;
        init;
    }

    func ToString() string {
        return nameof(UnknownBox) + "-" + Header.Type
    }

    protected open override func Render(file Stream) {
        file.Write(Data)
    }
}
