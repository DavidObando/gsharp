package Oahu.Decrypt.Mpeg4.Boxes.AC4SpecificBox

import Oahu.Decrypt.Mpeg4.Util

class Ac4BitrateDsi {
    var BitRateMode BitRateMode
    var BitRate uint32
    var BitRatePrecision uint32

    init(reader BitReader) {
        BitRateMode = BitRateMode(reader.Read(2))
        BitRate = reader.Read(32)
        BitRatePrecision = reader.Read(32)
    }
}
