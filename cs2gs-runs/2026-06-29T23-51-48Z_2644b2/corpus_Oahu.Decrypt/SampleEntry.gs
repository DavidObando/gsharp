package Oahu.Decrypt.Mpeg4.Boxes

import System.Diagnostics
import System.IO
import Oahu.Decrypt.Mpeg4.Util

@DebuggerDisplay("{DebuggerDisplay,nq}")
open class SampleEntry : Box {
    private let reserved []uint8

    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        reserved = file.ReadBlock(6)
        DataReferenceIndex = file.ReadUInt16BE()
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(8)

    prop DataReferenceIndex uint16 {
        get;
        init;
    }

    @DebuggerHidden
    private prop DebuggerDisplay string -> "[${Header.Type}] - " + switch Header.Type {
        case "text": "Text SampleEntry"
        case "mp4s": "MpegSampleEntry"
        case "mp4v": "MP4VisualSampleEntry"
        case "mp4a": "MP4AudioSampleEntry"
        case "aavd": "Audible AAX(C) Protected AudioSampleEntry"
        case "encv": "Protected VisualSampleEntry"
        case "enca": "Protected AudioSampleEntry"
        case "ec-3": "EC3SampleEntry"
        case "ac-4": "AC4SampleEntry"
        default: "[UNKNOWN]"
    }

    protected open override func Render(file Stream) {
        file.Write(reserved)
        file.WriteUInt16BE(DataReferenceIndex)
    }
}
