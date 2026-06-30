package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class TencBox : FullBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        file.ReadByte()
        if Version == uint8(0) {
            file.ReadByte()
        } else {
            let value = file.ReadByte()
            DefaultCryptByteBlock = uint8((value >> 4))
            DefaultSkipByteBlock = uint8((value & 0xf))
        }
        DefaultIsProtected = file.ReadByte() != 0
        DefaultPerSampleIvSize = uint8(file.ReadByte())
        DefaultKID = Guid(file.ReadBlock(16), true)
        if DefaultIsProtected && DefaultPerSampleIvSize == uint8(0) {
            DefaultConstantIvSize = uint8(file.ReadByte())
            DefaultConstantIv = file.ReadBlock(DefaultConstantIvSize)
        } else {
            DefaultConstantIv = Array.Empty[uint8]()
        }
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(20) + int64((if (DefaultIsProtected && DefaultPerSampleIvSize == uint8(0)) { uint8(1) + DefaultConstantIvSize } else { 0 }))

    prop DefaultCryptByteBlock uint8 {
        get;
        init;
    }

    prop DefaultSkipByteBlock uint8 {
        get;
        init;
    }

    prop DefaultIsProtected bool {
        get;
        init;
    }

    prop DefaultPerSampleIvSize uint8 {
        get;
        init;
    }

    prop DefaultKID Guid {
        get;
        init;
    }

    prop DefaultConstantIvSize uint8 {
        get;
        init;
    }

    prop DefaultConstantIv []uint8 {
        get;
        init;
    }

    protected open override func Render(file Stream) {
        base.Render(file)
        var value int16 = 0
        if Version != uint8(0) {
            value = int16(((DefaultCryptByteBlock << 4) | (DefaultSkipByteBlock & uint8(0xf))))
        }
        file.WriteInt16BE(value)
        file.WriteByte(uint8((if DefaultIsProtected { 1 } else { 0 })))
        file.WriteByte(DefaultPerSampleIvSize)
        file.Write(DefaultKID.ToByteArray(true))
        if DefaultIsProtected && DefaultPerSampleIvSize == uint8(0) {
            file.WriteByte(uint8(DefaultConstantIv.Length))
            file.Write(DefaultConstantIv)
        }
    }
}
