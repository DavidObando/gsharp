package Oahu.Decrypt.Mpeg4.Descriptors

import System.IO
import Oahu.Decrypt.Mpeg4.Util

class UnknownDescriptor : BaseDescriptor {
    private let blob []uint8

    init(file Stream, header DescriptorHeader) : base(file, header) {
        blob = file.ReadBlock(Header.TotalBoxSize - Header.HeaderSize)
    }

    override prop InternalSize int32 -> base.InternalSize + blob.Length

    override func Render(file Stream) {
        file.Write(blob)
    }
}
