package Oahu.Decrypt.Mpeg4.Boxes

import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class TfhdBox : FullBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        TrackID = file.ReadUInt32BE()
        if BaseDataOffsetPresent {
            BaseDataOffset = file.ReadInt64BE()
        }
        if SampleDescriptionIndexPresent {
            SampleDescriptionIndex = file.ReadUInt32BE()
        }
        if DefaultSampleDurationPresent {
            DefaultSampleDuration = file.ReadUInt32BE()
        }
        if DefaultSampleSizePresent {
            DefaultSampleSize = file.ReadUInt32BE()
        }
        if DefaultSampleFlagsPresent {
            DefaultSampleFlags = file.ReadUInt32BE()
        }
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(4) + int64(OptionalFieldsSize)

    prop TrackID uint32 {
        get;
        init;
    }

    prop BaseDataOffset int64? {
        get;
        init;
    }

    prop SampleDescriptionIndex uint32? {
        get;
        init;
    }

    prop DefaultSampleDuration uint32? {
        get;
        init;
    }

    prop DefaultSampleSize uint32? {
        get;
        init;
    }

    prop DefaultSampleFlags uint32? {
        get;
        init;
    }

    prop DurationIsEmpty bool -> (Flags & 0x010000) == 0x010000
    prop DefaultBaseIsMoof bool -> (Flags & 0x020000) == 0x020000
    private prop OptionalFieldsSize int32 -> (if BaseDataOffsetPresent { 8 } else { 0 }) + (if SampleDescriptionIndexPresent { 4 } else { 0 }) + (if DefaultSampleDurationPresent { 4 } else { 0 }) + (if DefaultSampleSizePresent { 4 } else { 0 }) + (if DefaultSampleFlagsPresent { 4 } else { 0 })
    private prop BaseDataOffsetPresent bool -> (Flags & 1) == 1
    private prop SampleDescriptionIndexPresent bool -> (Flags & 2) == 2
    private prop DefaultSampleDurationPresent bool -> (Flags & 8) == 8
    private prop DefaultSampleSizePresent bool -> (Flags & 16) == 16
    private prop DefaultSampleFlagsPresent bool -> (Flags & 32) == 32

    protected open override func Render(file Stream) {
        base.Render(file)
        file.WriteUInt32BE(TrackID)
        if BaseDataOffset.HasValue {
            file.WriteInt64BE(BaseDataOffset.Value)
        }
        if SampleDescriptionIndex.HasValue {
            file.WriteUInt32BE(SampleDescriptionIndex.Value)
        }
        if DefaultSampleDuration.HasValue {
            file.WriteUInt32BE(DefaultSampleDuration.Value)
        }
        if DefaultSampleSize.HasValue {
            file.WriteUInt32BE(DefaultSampleSize.Value)
        }
        if DefaultSampleFlags.HasValue {
            file.WriteUInt32BE(DefaultSampleFlags.Value)
        }
    }
}
