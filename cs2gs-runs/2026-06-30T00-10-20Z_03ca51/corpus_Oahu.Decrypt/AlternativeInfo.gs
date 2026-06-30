package Oahu.Decrypt.Mpeg4.Boxes.AC4SpecificBox

import Oahu.Decrypt.Mpeg4.Util

class AlternativeInfo {
    var NameLen uint16
    var PresentationName string
    var NTargets uint8
    var TargetIds [](uint8, uint8)

    init(reader BitReader) {
        NameLen = uint16(reader.Read(16))
        let nameBts = [int32(NameLen)]char
        for var i = 0; i < int32(NameLen); i++ {
            nameBts[i] = char(reader.Read(8))
        }
        PresentationName = string(nameBts)
        NTargets = uint8(reader.Read(5))
        TargetIds = [int32(NTargets)](uint8, uint8)
        for var i = 0; i < int32(NameLen); i++ {
            TargetIds[i] = (uint8(reader.Read(3)), uint8(reader.Read(8)))
        }
    }
}
