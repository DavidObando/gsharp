package Oahu.Decrypt.Mpeg4.Boxes.EC3SpecificBox

import System.IO

class Ec3Extensions {
    shared {
        private let FfAc3ChannelsTab []uint8 = []uint8{uint8(2), uint8(1), uint8(2), uint8(3), uint8(3), uint8(4), uint8(4), uint8(5)}
    }
}

func (indSub Ec3IndependentSubstream) GetSampleRate() int32 -> if indSub.Fscod == uint8(0) { 48000 } else { if indSub.Fscod == uint8(1) { 44100 } else { if indSub.Fscod == uint8(2) { 32000 } else { throw InvalidDataException("${nameof(indSub.Fscod)} value of ${indSub.Fscod} is not valid")
    default(int32) } } }

func (indSub Ec3IndependentSubstream) ChannelCount() int32 -> int32(Ec3Extensions.FfAc3ChannelsTab[uint8(indSub.Acmod)]) + (if indSub.Lfeon { 1 } else { 0 })
