package Oahu.Decrypt.Mpeg4.Boxes.AC4SpecificBox

import Oahu.Decrypt.Mpeg4.Util

class Ac4Substream {
    var DsiSfMultiplier uint8
    var BSubstreamBitrateIndicator bool
    var SubstreamBitrateIndicator uint8?
    var DsiSubstreamChannelMask ChannelGroups?
    var BAjoc bool?
    var BStaticDmx bool?
    var NDmxObjectsMinus1 uint8?
    var NUmxObjectsMinus1 uint8?
    var BSubstreamContainsBedObjects bool?
    var BSubstreamContainsDynamicObjects bool?
    var BSubstreamContainsIsfObjects bool?

    init(info Ac4SubstreamGroupDsi, reader BitReader) {
        DsiSfMultiplier = uint8(reader.Read(2))
        BSubstreamBitrateIndicator = reader.ReadBool()
        if BSubstreamBitrateIndicator {
            SubstreamBitrateIndicator = uint8(reader.Read(5))
        }
        if info.BChannelCoded {
            DsiSubstreamChannelMask = ChannelGroups(reader.Read(24))
        } else {
            BAjoc = reader.ReadBool()
            if BAjoc.Value {
                BStaticDmx = reader.ReadBool()
                if BStaticDmx.Value {
                    NDmxObjectsMinus1 = uint8(reader.Read(4))
                }
                NUmxObjectsMinus1 = uint8(reader.Read(6))
            }
            BSubstreamContainsBedObjects = reader.ReadBool()
            BSubstreamContainsDynamicObjects = reader.ReadBool()
            BSubstreamContainsIsfObjects = reader.ReadBool()
            reader.Read(1)
        }
    }
}
