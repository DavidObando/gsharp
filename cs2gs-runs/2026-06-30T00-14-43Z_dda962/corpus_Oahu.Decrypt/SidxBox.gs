package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class SidxBox : FullBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        ReferenceId = file.ReadUInt32BE()
        Timescale = file.ReadInt32BE()
        if Version == uint8(0) {
            EarliestPresentationTime = file.ReadUInt32BE()
            FirstOffset = file.ReadUInt32BE()
        } else {
            EarliestPresentationTime = file.ReadInt64BE()
            FirstOffset = file.ReadInt64BE()
        }
        file.ReadInt16BE()
        let referenceCount int32 = file.ReadUInt16BE()
        Segments = [referenceCount]Segment
        for var i = 0; i < Segments.Length; i++ {
            Segments[i] = Segment(file)
        }
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(8) + int64((if Version == uint8(0) { 8 } else { 16 })) + int64(4) + int64(Segments.Length * 12)

    prop ReferenceId uint32 {
        get;
        init;
    }

    prop Timescale int32 {
        get;
        init;
    }

    prop EarliestPresentationTime int64 {
        get;
        init;
    }

    prop FirstOffset int64 {
        get;
        init;
    }

    prop Segments []Segment {
        get;
        init;
    }

    protected open override func Render(file Stream) {
        base.Render(file)
        file.WriteUInt32BE(ReferenceId)
        file.WriteInt32BE(Timescale)
        if Version == uint8(0) {
            file.WriteUInt32BE(uint32(EarliestPresentationTime))
            file.WriteUInt32BE(uint32(FirstOffset))
        } else {
            file.WriteInt64BE(EarliestPresentationTime)
            file.WriteInt64BE(FirstOffset)
        }
        file.WriteInt16BE(0)
        file.WriteInt16BE(int16(Segments.Length))
        for segment in Segments {
            segment!!.Save(file)
        }
    }

    class Segment {
        private var typeAndSize uint32
        private var subsegmentDuration uint32
        private var sap uint32

        internal init(file Stream) {
            typeAndSize = file.ReadUInt32BE()
            subsegmentDuration = file.ReadUInt32BE()
            sap = file.ReadUInt32BE()
        }

        prop ReferenceType bool {
            get -> (typeAndSize & 0x80000000U) == 0x80000000U
            set -> typeAndSize = if value { typeAndSize | 0x80000000U } else { typeAndSize & uint32(0x7FFFFFFF) }
        }

        prop ReferenceSize int32 {
            get -> int32((typeAndSize & uint32(0x7FFFFFFF)))
            set {
                ArgumentOutOfRangeException.ThrowIfLessThan(value, 0, nameof(ReferenceSize))
                typeAndSize = (typeAndSize & 0x80000000U) | uint32(value)
            }
        }

        prop SubsegmentDuration uint32 {
            get -> subsegmentDuration
            set -> subsegmentDuration = value
        }

        prop StartsWithSAP bool {
            get -> (sap & 0x80000000U) == 0x80000000U
            set -> sap = if value { sap | 0x80000000U } else { sap & uint32(0x7FFFFFFF) }
        }

        prop SapType int32 {
            get -> int32((sap >> 28)) & 7
            set {
                ArgumentOutOfRangeException.ThrowIfLessThan(value, 0, nameof(SapType))
                ArgumentOutOfRangeException.ThrowIfGreaterThan(value, 7, nameof(SapType))
                sap = (sap & 0x8FFFFFFFU) | uint32((value << 28))
            }
        }

        prop SapDeltaTime int32 {
            get -> int32(sap) & 0xFFFFFFF
            set {
                ArgumentOutOfRangeException.ThrowIfLessThan(value, 0, nameof(SapType))
                ArgumentOutOfRangeException.ThrowIfGreaterThan(value, 0xFFFFFFF, nameof(SapType))
                sap = (sap & 0xF0000000U) | uint32(value)
            }
        }

        func Save(file Stream) {
            file.WriteUInt32BE(typeAndSize)
            file.WriteUInt32BE(subsegmentDuration)
            file.WriteUInt32BE(sap)
        }
    }
}
