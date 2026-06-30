package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.IO
import System.Linq
import Oahu.Decrypt.Mpeg4.Util

open class SencBox : FullBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        let sampleCount = file.ReadInt32BE()
        if UseSubSampleEncryption {
            throw NotSupportedException(nameof(UseSubSampleEncryption))
        }
        let ivSize = int32(((header.TotalBoxSize - int64(16)) / int64(sampleCount)))
        IVs = [sampleCount][]uint8
        for var i = 0; i < sampleCount; i++ {
            IVs[i] = file.ReadBlock(ivSize)
        }
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(4) + int64(IVs.Sum((iv []uint8) -> iv.Length))
    prop UseSubSampleEncryption bool -> (Flags & 2) == 2

    prop IVs [][]uint8 {
        get;
        init;
    }

    protected open override func Render(file Stream) {
        base.Render(file)
        file.WriteInt32BE(IVs.Length)
        for iv in IVs {
            file.Write(iv!!)
        }
    }
}
