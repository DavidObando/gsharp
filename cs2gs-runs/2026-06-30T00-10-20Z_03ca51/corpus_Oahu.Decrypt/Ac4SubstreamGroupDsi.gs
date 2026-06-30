package Oahu.Decrypt.Mpeg4.Boxes.AC4SpecificBox

import Oahu.Decrypt.Mpeg4.Util

class Ac4SubstreamGroupDsi {
    var BSubstreamsPresent bool
    var BHsfExt bool
    var BChannelCoded bool
    var NSubstreams uint8
    var Substreams []Ac4Substream
    var BContentType bool
    var ContentClassifier uint8?
    var BLanguageIndicator bool?
    var NLanguageTagBytes int32?
    var LanguageTagBytes []?uint8

    init(reader BitReader) {
        BSubstreamsPresent = reader.ReadBool()
        BHsfExt = reader.ReadBool()
        BChannelCoded = reader.ReadBool()
        NSubstreams = uint8(reader.Read(8))
        Substreams = [int32(NSubstreams)]Ac4Substream
        for var i = 0; i < int32(NSubstreams); i++ {
            Substreams[i] = Ac4Substream(this, reader)
        }
        BContentType = reader.ReadBool()
        if BContentType {
            ContentClassifier = uint8(reader.Read(3))
            BLanguageIndicator = reader.ReadBool()
            if BLanguageIndicator.Value {
                NLanguageTagBytes = uint8(reader.Read(6))
                LanguageTagBytes = [NLanguageTagBytes.Value]uint8
                for var i = 0; i < LanguageTagBytes!!.Length; i++ {
                    LanguageTagBytes!![i] = uint8(reader.Read(8))
                }
            }
        }
    }
}
