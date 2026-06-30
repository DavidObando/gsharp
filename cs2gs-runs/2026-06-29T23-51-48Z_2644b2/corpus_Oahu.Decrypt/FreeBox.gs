package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.IO

open class FreeBox : Box {
    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        for var i = Header.HeaderSize; int64(i) < Header.TotalBoxSize; i++ {
            file.ReadByte()
        }
    }

    private init(header BoxHeader, parent IBox?) : base(header, parent) {
    }

    open override prop RenderSize int64 -> base.RenderSize + Header.TotalBoxSize - int64(Header.HeaderSize)

    protected open override func Render(file Stream) {
        var totalToWrite = Header.TotalBoxSize - int64(Header.HeaderSize)
        let blankData = [int32(Math.Min(8 * 1024, totalToWrite))]uint8
        while totalToWrite > int64(0) {
            let toWrite = int32(Math.Min(blankData!!.Length, totalToWrite))
            file.Write(blankData!!, 0, toWrite)
            totalToWrite -= int64(toWrite)
        }
    }

    shared {
        const MinSize int32 = 8

        func Create(freeSize int64, parent IBox?) FreeBox {
            let header = BoxHeader(freeSize, "free")
            let free = FreeBox(header, parent)
            parent?.Children.Add(free)
            return free
        }
    }
}
