package Oahu.Decrypt.Mpeg4.Boxes.EC3SpecificBox

import System.IO
import Oahu.Decrypt.Mpeg4.Util

class Ec3IndependentSubstream {
    var Fscod uint8
    var Bsid uint8
    var Asvc bool
    var Bsmod uint8
    var Acmod AudioCodingMode
    var Lfeon bool
    var NumDepSub uint8
    var ChanLoc ChannelLocation

    init(reader BitReader) {
        Fscod = uint8(reader.Read(2))
        Bsid = uint8(reader.Read(5))
        if Bsid != uint8(16) {
            throw InvalidDataException("Invalid bsid value: $Bsid. Expected 16 for E-AC-3.")
        }
        reader.Position += 1
        Asvc = reader.ReadBool()
        Bsmod = uint8(reader.Read(3))
        Acmod = AudioCodingMode(reader.Read(3))
        Lfeon = reader.Read(1) > uint32(0)
        reader.Position += 3
        let numDepSub = reader.Read(4)
        if numDepSub > uint32(0) {
            ChanLoc = ChannelLocation(reader.Read(9))
        } else {
            reader.Position++
        }
    }
}
