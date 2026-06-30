package Oahu.Decrypt.Mpeg4.Boxes

import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class BtrtBox : Box {
    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        BufferSizeDB = file.ReadUInt32BE()
        MaxBitrate = file.ReadUInt32BE()
        AvgBitrate = file.ReadUInt32BE()
    }

    private init(bufferSizeDB uint32, maxBitrate uint32, avgBitrate uint32, header BoxHeader, parent IBox) : base(header, parent) {
        BufferSizeDB = bufferSizeDB
        MaxBitrate = maxBitrate
        AvgBitrate = avgBitrate
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(12)

    prop BufferSizeDB uint32 {
        get;
        init;
    }

    prop MaxBitrate uint32
    prop AvgBitrate uint32

    protected open override func Render(file Stream) {
        file.WriteUInt32BE(BufferSizeDB)
        file.WriteUInt32BE(MaxBitrate)
        file.WriteUInt32BE(AvgBitrate)
    }

    shared {
        func Create(bufferSizeDB uint32, maxBitrate uint32, avgBitrate uint32, parent Box) BtrtBox {
            let header = BoxHeader(20, "btrt")
            let btrt = BtrtBox(bufferSizeDB, maxBitrate, avgBitrate, header, parent)
            parent.Children.Add(btrt)
            return btrt
        }
    }
}
