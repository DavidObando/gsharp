package Oahu.Decrypt.Mpeg4.Boxes

import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class AudioSampleEntry : SampleEntry {
    private let reserved []uint8
    private let reserved2 []uint8
    private let sampleRateLoworder uint16

    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        reserved = file.ReadBlock(8)
        ChannelCount = file.ReadUInt16BE()
        SampleSize = file.ReadUInt16BE()
        PreDefined = file.ReadInt16BE()
        reserved2 = file.ReadBlock(2)
        SampleRate = file.ReadUInt16BE()
        sampleRateLoworder = file.ReadUInt16BE()
        LoadChildren(file)
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(20)
    prop ChannelCount uint16

    prop SampleSize uint16 {
        get;
        init;
    }

    prop PreDefined int16 {
        get;
        init;
    }

    prop SampleRate uint16
    prop Esds EsdsBox? -> GetChild[EsdsBox]()
    prop Dec3 Dec3Box? -> GetChild[Dec3Box]()
    prop Dac4 Dac4Box? -> GetChild[Dac4Box]()

    protected open override func Render(file Stream) {
        base.Render(file)
        file.Write(reserved)
        file.WriteUInt16BE(ChannelCount)
        file.WriteUInt16BE(SampleSize)
        file.WriteInt16BE(PreDefined)
        file.Write(reserved2)
        file.WriteUInt16BE(SampleRate)
        file.WriteUInt16BE(sampleRateLoworder)
    }
}
