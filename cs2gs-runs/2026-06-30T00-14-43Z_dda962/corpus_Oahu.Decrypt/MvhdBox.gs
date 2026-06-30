package Oahu.Decrypt.Mpeg4.Boxes

import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class MvhdBox : HeaderBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        Rate = file.ReadInt32BE()
        Volume = file.ReadInt16BE()
        Reserved = file.ReadUInt16BE()
        Reserved2 = file.ReadUInt64BE()
        Matrix = file.ReadBlock(4 * 9)
        Pre_defined = file.ReadBlock(4 * 6)
        NextTrackID = file.ReadUInt32BE()
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(4) + int64(4) + int64(2) + int64(2) + int64(8) + int64(Matrix.Length) + int64(Pre_defined.Length) + int64(4)
    prop Timescale uint32

    prop Rate int32 {
        get;
        init;
    }

    prop Volume int16 {
        get;
        init;
    }

    prop Reserved uint16 {
        get;
        init;
    }

    prop Reserved2 uint64 {
        get;
        init;
    }

    prop Matrix []uint8 {
        get;
        init;
    }

    prop Pre_defined []uint8 {
        get;
        init;
    }

    prop NextTrackID uint32

    protected open override func Render(file Stream) {
        base.Render(file)
        file.WriteInt32BE(Rate)
        file.WriteInt16BE(Volume)
        file.WriteUInt16BE(Reserved)
        file.WriteUInt64BE(Reserved2)
        file.Write(Matrix)
        file.Write(Pre_defined)
        file.WriteUInt32BE(NextTrackID)
    }

    protected open override func ReadBeforeDuration(file Stream) {
        Timescale = file.ReadUInt32BE()
    }

    protected open override func WriteBeforeDuration(file Stream) {
        file.WriteUInt32BE(Timescale)
    }
}
