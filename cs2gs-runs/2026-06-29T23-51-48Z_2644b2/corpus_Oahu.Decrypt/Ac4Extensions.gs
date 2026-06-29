package Oahu.Decrypt.Mpeg4.Boxes.AC4SpecificBox

import System.Linq

class Ac4Extensions {
    shared {
        private let NumChannelsPerGroup []uint8 = []uint8{uint8(2), uint8(1), uint8(2), uint8(2), uint8(2), uint8(2), uint8(1), uint8(2), uint8(2), uint8(1), uint8(1), uint8(1), uint8(1), uint8(2), uint8(1), uint8(1), uint8(2), uint8(2), uint8(2)}

        func ChannelCount(channels ChannelGroups) int32 {
            var channelCount = 0
            for var g = 0; g <= 18; g++ {
                let group = ChannelGroups((1 << g))
                if channels.HasFlag(group) {
                    channelCount += int32(Ac4Extensions.NumChannelsPerGroup[g])
                }
            }
            return channelCount
        }
    }
}

func (ac4DsiV1 Ac4DsiV1?) SampleRate() int32? -> if ac4DsiV1 == nil { nil } else { if ac4DsiV1!!.FsIndex == uint8(0) { 44100 } else { 48000 } }

func (ac4DsiV1 Ac4DsiV1?) AverageBitrate() uint32? {
    if ac4DsiV1 == nil {
        return nil
    }
    if ac4DsiV1!!.Ac4BitrateDsi.BitRate != uint32(0) {
        return ac4DsiV1!!.Ac4BitrateDsi.BitRate
    }
    for presentation in ac4DsiV1!!.Presentations.OfType[Ac4PresentationV1Dsi]().Where((p Ac4PresentationV1Dsi) -> p.BPresentationBitrateInfo) {
        if presentation!!.Ac4BitrateDsi is Ac4BitrateDsi && (presentation!!.Ac4BitrateDsi as Ac4BitrateDsi)!!.BitRate != uint32(0) {
            return (presentation!!.Ac4BitrateDsi as Ac4BitrateDsi)!!.BitRate
        }
    }
    return nil
}

func (ac4DsiV1 Ac4DsiV1?) Channels() ChannelGroups? {
    if ac4DsiV1 == nil {
        return nil
    }
    for presentation in ac4DsiV1!!.Presentations.OfType[Ac4PresentationV1Dsi]().OrderByDescending((p Ac4PresentationV1Dsi) -> p.PresentationVersion) {
        if presentation!!.BPresentationChannelCoded == true {
            return presentation!!.PresentationChannelMaskV1
        } else if presentation!!.Substream?.BChannelCoded == true {
            return presentation!!.Substream!!.Substreams[0].DsiSubstreamChannelMask
        }
    }
    return nil
}
