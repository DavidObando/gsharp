package Oahu.Decrypt.Mpeg4.Boxes.AC4SpecificBox

import System
import Oahu.Decrypt.Mpeg4.Util

class Ac4DsiV1 {
    var Ac4DsiVersion uint8
    var BitstreamVersion uint8
    var FsIndex uint8
    var FrameRateIndex uint8
    var NPresentations uint16
    var BProgramId bool?
    var ShortProgramId uint16?
    var BUuid bool?
    var ProgramUuid Guid?
    var Ac4BitrateDsi Ac4BitrateDsi
    var Presentations []object?

    init(reader BitReader) {
        Ac4DsiVersion = uint8(reader.Read(3))
        BitstreamVersion = uint8(reader.Read(7))
        FsIndex = uint8(reader.Read(1))
        FrameRateIndex = uint8(reader.Read(4))
        NPresentations = uint16(reader.Read(9))
        if BitstreamVersion > uint8(1) {
            BProgramId = reader.ReadBool()
            if BProgramId.Value {
                ShortProgramId = uint16(reader.Read(16))
                BUuid = reader.ReadBool()
                if BUuid.Value {
                    ProgramUuid = Guid(reader.Read(32), uint16(reader.Read(16)), uint16(reader.Read(16)), uint8(reader.Read(8)), uint8(reader.Read(8)), uint8(reader.Read(8)), uint8(reader.Read(8)), uint8(reader.Read(8)), uint8(reader.Read(8)), uint8(reader.Read(8)), uint8(reader.Read(8)))
                }
            }
        }
        Ac4BitrateDsi = Ac4BitrateDsi(reader)
        reader.ByteAlign()
        Presentations = [int32(NPresentations)]object
        for var i = 0; i < int32(NPresentations); i++ {
            var presentationBytes uint32
            let presentationVersion = reader.Read(8)
            var presBytes = reader.Read(8)
            if presBytes == uint32(255) {
                let addPresBytes = reader.Read(16)
                presBytes += addPresBytes
            }
            if presentationVersion == uint32(0) {
                throw NotSupportedException("ac4_presentation_v0_dsi not yet supported")
            } else {
                if presentationVersion == uint32(1) || presentationVersion == uint32(2) {
                    let start = reader.Position
                    Presentations[i] = Ac4PresentationV1Dsi(presentationVersion, presBytes, reader)
                    presentationBytes = uint32((reader.Position - start)) / uint32(8)
                } else {
                    presentationBytes = uint32(0)
                }
            }
            let skipBytes = presBytes - presentationBytes
            reader.Position += 8 * int32(skipBytes)
        }
    }
}
