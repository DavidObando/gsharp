package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class VisualSampleEntry : SampleEntry {
    private let preDefined1 []uint8
    private let reserved []uint8
    private let preDefined2 []uint8
    private let reserved2 []uint8
    private let preDefined3 []uint8

    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        preDefined1 = file.ReadBlock(2)
        reserved = file.ReadBlock(2)
        preDefined2 = file.ReadBlock(4 * 3)
        Width = file.ReadUInt16BE()
        Height = file.ReadUInt16BE()
        HorizontalResolution = file.ReadUInt32BE()
        VerticalResolution = file.ReadUInt32BE()
        reserved2 = file.ReadBlock(4)
        FrameCount = file.ReadUInt16BE()
        let compressorNameBytes = file.ReadBlock(32)
        let displaySize = compressorNameBytes!![0]
        if displaySize > uint8(31) {
            throw InvalidOperationException("Compressor name must be 31 characters or fewer.")
        }
        CompressorName = System.Text.Encoding.UTF8.GetString(compressorNameBytes!!, 1, displaySize)
        Depth = file.ReadUInt16BE()
        preDefined3 = file.ReadBlock(2)
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(preDefined1.Length) + int64(reserved.Length) + int64(preDefined2.Length) + int64(2 * 4) + int64(4 * 2) + int64(reserved2.Length) + int64(preDefined3.Length) + int64(32)

    prop Width uint16 {
        get;
        init;
    }

    prop Height uint16 {
        get;
        init;
    }

    prop HorizontalResolution uint32 {
        get;
        init;
    }

    prop VerticalResolution uint32 {
        get;
        init;
    }

    prop FrameCount uint16 {
        get;
        init;
    }

    prop CompressorName string {
        get;
        init;
    }

    prop Depth uint16 {
        get;
        init;
    }

    protected open override func Render(file Stream) {
        base.Render(file)
        file.Write(preDefined1)
        file.Write(reserved)
        file.Write(preDefined2)
        file.WriteUInt16BE(Width)
        file.WriteUInt16BE(Height)
        file.WriteUInt32BE(HorizontalResolution)
        file.WriteUInt32BE(VerticalResolution)
        file.Write(reserved2)
        file.WriteUInt16BE(FrameCount)
        let compressorNameBytes = [32]uint8
        if CompressorName.Length > 31 {
            throw InvalidOperationException("Compressor name must be 31 characters or fewer.")
        }
        compressorNameBytes!![0] = uint8(CompressorName.Length)
        System.Text.Encoding.UTF8.GetBytes(CompressorName, 0, CompressorName.Length, compressorNameBytes!!, 1)
        file.Write(compressorNameBytes!!)
        file.WriteUInt16BE(Depth)
        file.Write(preDefined3)
    }
}
