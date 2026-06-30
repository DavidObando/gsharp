package Oahu.Decrypt.Mpeg4.Boxes

import System.IO
import Oahu.Decrypt.Mpeg4.Util

interface ISaioBox : IBox {
    prop AuxInfoType uint32 {
        get;
    }

    prop AuxInfoTypeParameter uint32 {
        get;
    }

    prop EntryCount int32 {
        get;
    }
}

open class SaioBox : FullBox, ISaioBox {
    private let offsets32 []?uint32
    private let offsets64 []?int64

    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        if (Flags & 1) == 1 {
            AuxInfoType = file.ReadUInt32BE()
            AuxInfoTypeParameter = file.ReadUInt32BE()
        }
        EntryCount = file.ReadInt32BE()
        if Version == uint8(0) {
            offsets32 = [EntryCount]uint32
            for var i = 0; i < EntryCount; i++ {
                offsets32!![i] = file.ReadUInt32BE()
            }
        } else {
            offsets64 = [EntryCount]int64
            for var i = 0; i < EntryCount; i++ {
                offsets64!![i] = file.ReadInt64BE()
            }
        }
    }

    open override prop RenderSize int64 -> base.RenderSize + int64((if (Flags & 1) == 1 { 8 } else { 0 })) + int64(4) + int64((if Version == uint8(0) { (offsets32?.Length ?? 0) * 4 } else { (offsets64?.Length ?? 0) * 8 }))

    prop AuxInfoType uint32 {
        get;
        init;
    }

    prop AuxInfoTypeParameter uint32 {
        get;
        init;
    }

    prop EntryCount int32 {
        get;
        init;
    }

    protected open override func Render(file Stream) {
        base.Render(file)
        if (Flags & 1) == 1 {
            file.WriteUInt32BE(AuxInfoType)
            file.WriteUInt32BE(AuxInfoTypeParameter)
        }
        file.WriteInt32BE(EntryCount)
        if offsets32 != nil {
            for offset in offsets32!! {
                file.WriteUInt32BE(offset)
            }
        } else if offsets64 != nil {
            for offset in offsets64!! {
                file.WriteInt64BE(offset)
            }
        }
    }
}
