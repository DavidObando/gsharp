package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class SaizBox : FullBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        if (Flags & 1) == 1 {
            AuxInfoType = file.ReadUInt32BE()
            AuxInfoTypeParameter = file.ReadUInt32BE()
        }
        DefaultInfoSampleSize = uint8(file.ReadByte())
        let sampleCount = file.ReadInt32BE()
        SampleInfoSizes = if DefaultInfoSampleSize == uint8(0) { file.ReadBlock(sampleCount) } else { Array.Empty[uint8]() }
    }

    open override prop RenderSize int64 -> base.RenderSize + int64((if (Flags & 1) == 1 { 8 } else { 0 })) + int64(5) + int64((if DefaultInfoSampleSize == uint8(0) { SampleInfoSizes.Length } else { 0 }))

    prop AuxInfoType uint32 {
        get;
        init;
    }

    prop AuxInfoTypeParameter uint32 {
        get;
        init;
    }

    prop DefaultInfoSampleSize uint8 {
        get;
        init;
    }

    prop SampleInfoSizes []uint8 {
        get;
        init;
    }

    protected open override func Render(file Stream) {
        base.Render(file)
        if (Flags & 1) == 1 {
            file.WriteUInt32BE(AuxInfoType)
            file.WriteUInt32BE(AuxInfoTypeParameter)
        }
        file.WriteByte(DefaultInfoSampleSize)
        file.WriteInt32BE(SampleInfoSizes.Length)
        if DefaultInfoSampleSize == uint8(0) {
            file.Write(SampleInfoSizes)
        }
    }
}
