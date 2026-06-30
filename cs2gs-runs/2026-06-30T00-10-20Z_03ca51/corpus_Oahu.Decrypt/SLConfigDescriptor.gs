package Oahu.Decrypt.Mpeg4.Descriptors

import System.IO
import Oahu.Decrypt.Mpeg4.Util

internal class SLConfigDescriptor : BaseDescriptor {
    private let blob []uint8

    init(file Stream, header DescriptorHeader) : base(file, header) {
        Predefined = file.ReadByte()
        blob = file.ReadBlock(Header.TotalBoxSize - Header.HeaderSize - 1)
    }

    private init(predefined uint8, blob []uint8) : base(6) {
        Predefined = predefined
        this.blob = blob
    }

    prop Predefined int32
    override prop InternalSize int32 -> base.InternalSize + 1 + blob.Length

    override func Render(file Stream) {
        file.WriteByte(uint8(Predefined))
        file.Write(blob)
    }

    shared {
        func CreateMp4() SLConfigDescriptor -> SLConfigDescriptor(2, []uint8{})
    }
}
