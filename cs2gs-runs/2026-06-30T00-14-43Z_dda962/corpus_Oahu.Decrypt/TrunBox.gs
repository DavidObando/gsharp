package Oahu.Decrypt.Mpeg4.Boxes

import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class TrunBox : FullBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        let sampleCount = file.ReadUInt32BE()
        if DataOffsetPresent {
            DataOffset = file.ReadInt32BE()
        }
        if FirstSampleFlagsPresent {
            FirstSampleFlags = file.ReadUInt32BE()
        }
        Samples = [int32(sampleCount)]SampleInfo
        for var i = 0; int64(i) < int64(sampleCount); i++ {
            let sampleDuration uint32? = if SampleDurationPresent { file.ReadUInt32BE() } else { nil }
            let sampleSize int32? = if SampleSizePresent { file.ReadInt32BE() } else { nil }
            let sampleFlags uint32? = if SampleFlagsPresent { file.ReadUInt32BE() } else { nil }
            let sampleCompositionTimeOffset int32? = if SampleCompositionTimeOffsetsPresent { file.ReadInt32BE() } else { nil }
            Samples[i] = SampleInfo(sampleDuration, sampleSize, sampleFlags, sampleCompositionTimeOffset)
        }
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(4) + int64((if DataOffsetPresent { 4 } else { 0 })) + int64((if FirstSampleFlagsPresent { 4 } else { 0 })) + int64(SampleInfoSize * Samples.Length)

    prop DataOffset int32 {
        get;
        init;
    }

    prop FirstSampleFlags uint32 {
        get;
        init;
    }

    prop Samples []SampleInfo {
        get;
        init;
    }

    prop SampleDurationPresent bool -> (Flags & 0x100) == 0x100
    prop SampleSizePresent bool -> (Flags & 0x200) == 0x200
    private prop DataOffsetPresent bool -> (Flags & 1) == 1
    private prop FirstSampleFlagsPresent bool -> (Flags & 4) == 4
    private prop SampleFlagsPresent bool -> (Flags & 0x400) == 0x400
    private prop SampleCompositionTimeOffsetsPresent bool -> (Flags & 0x800) == 0x800
    private prop SampleInfoSize int32 -> (if SampleDurationPresent { 4 } else { 0 }) + (if SampleSizePresent { 4 } else { 0 }) + (if SampleFlagsPresent { 4 } else { 0 }) + (if SampleCompositionTimeOffsetsPresent { 4 } else { 0 })

    protected open override func Render(file Stream) {
        base.Render(file)
        file.WriteInt32BE(Samples.Length)
        if DataOffsetPresent {
            file.WriteInt32BE(DataOffset)
        }
        if FirstSampleFlagsPresent {
            file.WriteUInt32BE(FirstSampleFlags)
        }
        for var i = 0; i < Samples.Length; i++ {
            if SampleDurationPresent {
                file.WriteUInt32BE(Samples[i].SampleDuration ?? uint32(0))
            }
            if SampleSizePresent {
                file.WriteInt32BE(Samples[i].SampleSize ?? 0)
            }
            if SampleFlagsPresent {
                file.WriteUInt32BE(Samples[i].SampleFlags ?? uint32(0))
            }
            if SampleCompositionTimeOffsetsPresent {
                file.WriteInt32BE(Samples[i].SampleCompositionTimeOffset ?? 0)
            }
        }
    }

    class SampleInfo(SampleDuration uint32?, SampleSize int32?, SampleFlags uint32?, SampleCompositionTimeOffset int32?) {
    }
}
