package Oahu.Decrypt.Mpeg4.Boxes.AC4SpecificBox

import System
import Oahu.Decrypt.Mpeg4.Util

class Ac4PresentationV1Dsi {
    var PresentationVersion uint32
    var PresentationConfigV1 uint8
    var BAddEmdfSubstreams bool
    var Mdcompat uint8?
    var BPresentationId bool?
    var PresentationId uint8?
    var DsiFrameRateMultiplyInfo uint8?
    var DsiFrameRateFractionInfo uint8?
    var PresentationEmdfVersion uint8?
    var PresentationKeyId uint16?
    var BPresentationChannelCoded bool?
    var DsiPresentationChMode uint8?
    var PresB4BackChannelsPresent uint8?
    var PresTopChannelPairs uint8?
    var PresentationChannelMaskV1 ChannelGroups?
    var BPresentationCoreDiffers bool?
    var BPresentationCoreChannelCoded bool?
    var DsiPresentationChannelModeCore uint8?
    var BPresentationFilter bool?
    var BEnablePresentation bool?
    var NFilterBytes uint8?
    var FilterData []?uint8
    var Substream Ac4SubstreamGroupDsi?
    var BPreVirtualized bool?
    var NAddEmdfSubstreams uint8?
    var SubstreamsEmdfs []?(uint8, uint16)
    var BPresentationBitrateInfo bool
    var Ac4BitrateDsi Ac4BitrateDsi?
    var BAlternative bool
    var AlternativeInfo AlternativeInfo?
    var DeIndicator uint8?
    var BExtendedPresentationId bool?
    var ExtendedPresentationId uint16?
    var DolbyAtmosIndicator bool?

    init(presentationVersion uint32, presBytes uint32, reader BitReader) {
        PresentationVersion = presentationVersion
        let start = reader.Position
        PresentationConfigV1 = uint8(reader.Read(5))
        if PresentationConfigV1 == uint8(6) {
            BAddEmdfSubstreams = true
        } else {
            Mdcompat = uint8(reader.Read(3))
            BPresentationId = reader.ReadBool()
            if BPresentationId.Value {
                PresentationId = uint8(reader.Read(5))
            }
            DsiFrameRateMultiplyInfo = uint8(reader.Read(2))
            DsiFrameRateFractionInfo = uint8(reader.Read(2))
            PresentationEmdfVersion = uint8(reader.Read(5))
            PresentationKeyId = uint16(reader.Read(10))
            BPresentationChannelCoded = reader.ReadBool()
            if BPresentationChannelCoded.Value {
                DsiPresentationChMode = uint8(reader.Read(5))
                if DsiPresentationChMode == (11 as uint8?) || DsiPresentationChMode == (12 as uint8?) || DsiPresentationChMode == (13 as uint8?) || DsiPresentationChMode == (14 as uint8?) {
                    PresB4BackChannelsPresent = uint8(reader.Read(1))
                    PresTopChannelPairs = uint8(reader.Read(2))
                }
                PresentationChannelMaskV1 = ChannelGroups(reader.Read(24))
            }
            BPresentationCoreDiffers = reader.ReadBool()
            if BPresentationCoreDiffers.Value {
                BPresentationCoreChannelCoded = reader.ReadBool()
                if BPresentationCoreChannelCoded.Value {
                    DsiPresentationChannelModeCore = uint8(reader.Read(2))
                }
            }
            BPresentationFilter = reader.ReadBool()
            if BPresentationFilter.Value {
                BEnablePresentation = reader.ReadBool()
                NFilterBytes = uint8(reader.Read(8))
                FilterData = [int32(NFilterBytes.Value)]uint8
                for var i = 0; i < int32(NFilterBytes.Value); i++ {
                    FilterData!![i] = uint8(reader.Read(8))
                }
            }
            if PresentationConfigV1 == uint8(0x1f) {
                Substream = Ac4SubstreamGroupDsi(reader)
            } else {
                throw NotSupportedException()
            }
            BPreVirtualized = reader.ReadBool()
            BAddEmdfSubstreams = reader.ReadBool()
        }
        if BAddEmdfSubstreams {
            NAddEmdfSubstreams = uint8(reader.Read(7))
            SubstreamsEmdfs = [int32(NAddEmdfSubstreams.Value)](uint8, uint16)
            for var j = 0; j < (NAddEmdfSubstreams as int32?); j++ {
                SubstreamsEmdfs!![j] = (uint8(reader.Read(5)), uint16(reader.Read(10)))
            }
        }
        BPresentationBitrateInfo = reader.ReadBool()
        if BPresentationBitrateInfo {
            Ac4BitrateDsi = Ac4BitrateDsi(reader)
        }
        BAlternative = reader.ReadBool()
        if BAlternative {
            reader.ByteAlign()
            AlternativeInfo = AlternativeInfo(reader)
        }
        reader.ByteAlign()
        let read = reader.Position - start
        if int64(read) <= int64((presBytes - uint32(1)) * uint32(8)) {
            DeIndicator = uint8(reader.Read(1))
            DolbyAtmosIndicator = reader.ReadBool()
            reader.Read(4)
            BExtendedPresentationId = reader.ReadBool()
            if BExtendedPresentationId.Value {
                ExtendedPresentationId = uint16(reader.Read(9))
            } else {
                reader.Read(1)
            }
        }
    }
}
