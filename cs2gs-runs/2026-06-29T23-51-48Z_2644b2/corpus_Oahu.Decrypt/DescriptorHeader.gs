package Oahu.Decrypt.Mpeg4.Descriptors

import System.IO

class DescriptorHeader {
    init(file Stream) {
        FilePosition = file.Position
        TagID = uint8(file.ReadByte())
        let start = file.Position
        let originalInternalSize = ExpandableClass.DecodeSize(file)
        let originalSizeOfSize = int32((file.Position - start))
        HeaderSize = originalSizeOfSize + 1
        TotalBoxSize = HeaderSize + originalInternalSize
    }

    init(tagId uint8) {
        TagID = tagId
        HeaderSize = 1
    }

    prop FilePosition int64

    prop TotalBoxSize int32 {
        get;
        init;
    }

    prop TagID uint8
    prop HeaderSize int32

    func GetEncodedSizeLength(internalSize int32) int32 {
        let minimumEncodeSize = HeaderSize - 1
        return ExpandableClass.GetSizeByteCount(internalSize, minimumEncodeSize)
    }
}
