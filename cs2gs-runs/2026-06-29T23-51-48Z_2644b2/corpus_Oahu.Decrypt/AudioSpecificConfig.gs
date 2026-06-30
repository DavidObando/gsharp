package Oahu.Decrypt.Mpeg4.Descriptors

import System
import System.IO
import Oahu.Decrypt.Mpeg4.Util

interface IASC {
    prop AudioObjectType int32
    prop SamplingFrequency int32
    prop ChannelConfiguration int32
    prop FrameLengthFlag bool
    prop DependsOnCoreCoder bool
}

class AudioSpecificConfig : BaseDescriptor, IASC {
    private var ascBlobLength int32 = 0
    private var bitReader BitReader

    init(file Stream, header DescriptorHeader) : base(file, header) {
        let ascBlob = file.ReadBlock(Header.TotalBoxSize - Header.HeaderSize)
        bitReader = AudioSpecificConfig.LoadAscBlob(this, ascBlob!!)
        ascBlobLength = ascBlob!!.Length
    }

    private init() : base(5) {
        bitReader = AudioSpecificConfig.LoadAscBlob(this, []uint8{uint8(0x13), uint8(0x90)})
        ascBlobLength = 2
    }

    prop AudioObjectType int32
    prop SamplingFrequency int32
    prop ChannelConfiguration int32
    prop FrameLengthFlag bool
    prop DependsOnCoreCoder bool
    override prop InternalSize int32 -> base.InternalSize + ascBlobLength

    prop AscBlob []uint8 {
        get -> GetAscBlob()
        set {
            bitReader = AudioSpecificConfig.LoadAscBlob(this, value)
            ascBlobLength = value.Length
        }
    }

    override func Render(file Stream) {
        file.Write(AscBlob)
    }

    private func GetAscBlob() []uint8 {
        ArgumentOutOfRangeException.ThrowIfLessThan(AudioObjectType, 0, nameof(AudioObjectType))
        ArgumentOutOfRangeException.ThrowIfGreaterThan(AudioObjectType, 32 + 63, nameof(AudioObjectType))
        let sampleIndex = Array.IndexOf(AudioSpecificConfig.AscSampleRates, SamplingFrequency)
        if sampleIndex < 0 {
            throw ArgumentException("Unsupported SamplingFrequency of $SamplingFrequency. Supported values are [${String.Join(", ", SamplingFrequency)}]", nameof(SamplingFrequency))
        }
        ArgumentOutOfRangeException.ThrowIfLessThan(ChannelConfiguration, 1, nameof(ChannelConfiguration))
        ArgumentOutOfRangeException.ThrowIfGreaterThan(ChannelConfiguration, 7, nameof(ChannelConfiguration))
        let writer = BitWriter()
        if AudioObjectType < int32(AudioSpecificConfig.AotEscape) {
            writer!!.Write(uint32(AudioObjectType), 5)
        } else {
            writer!!.Write(AudioSpecificConfig.AotEscape, 5)
            writer!!.Write(uint32(AudioObjectType) - uint32(32), 6)
        }
        writer!!.Write(uint32(sampleIndex), 4)
        writer!!.Write(uint32(ChannelConfiguration), 4)
        writer!!.Write(if FrameLengthFlag { 1u } else { uint32(0) }, 1)
        writer!!.Write(if DependsOnCoreCoder { 1u } else { uint32(0) }, 1)
        let startPos = bitReader.Position
        bitReader.CopyTo(writer!!)
        this.bitReader.Position = startPos
        return writer!!.ToByteArray()
    }

    private class InternalAudioSpecificConfig : IASC {
        prop AudioObjectType int32
        prop SamplingFrequency int32
        prop ChannelConfiguration int32
        prop FrameLengthFlag bool
        prop DependsOnCoreCoder bool
    }

    shared {
        let AscSampleRates []int32 = []int32{96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350}
        let MinSampleRate int32 = AudioSpecificConfig.AscSampleRates[^1]
        let MaxSampleRate int32 = AudioSpecificConfig.AscSampleRates[0]
        private const AotEscape uint8 = uint8(31)
        private let SupportedObjectTypes []uint8 = []uint8{uint8(1), uint8(2), uint8(3), uint8(4), uint8(6), uint8(7), uint8(17), uint8(19), uint8(20), uint8(21), uint8(22), uint8(23), uint8(42)}
        func CreateEmpty() AudioSpecificConfig -> AudioSpecificConfig()

        func Parse(ascBlob []uint8) IASC {
            let internalAsc = InternalAudioSpecificConfig()
            AudioSpecificConfig.LoadAscBlob(internalAsc!!, ascBlob)
            return internalAsc!!
        }

        private func LoadAscBlob(asc IASC, ascBlob []uint8) BitReader {
            let bitReader = BitReader(ascBlob)
            asc.AudioObjectType = int32(bitReader!!.Read(5))
            if asc.AudioObjectType == int32(AudioSpecificConfig.AotEscape) {
                asc.AudioObjectType = int32(bitReader!!.Read(6)) + 32
            }
            if Array.IndexOf(AudioSpecificConfig.SupportedObjectTypes, uint8(asc.AudioObjectType)) < 0 {
                throw NotSupportedException("${nameof(AudioObjectType)} of ${asc.AudioObjectType} is unsupported")
            }
            let samplingFrequencyIndex = bitReader!!.Read(4)
            asc.SamplingFrequency = if samplingFrequencyIndex <= uint32(12) { AudioSpecificConfig.AscSampleRates[samplingFrequencyIndex] } else { throw NotSupportedException("Sampling frequency index of $samplingFrequencyIndex is not supported.")
                default(int32) }
            asc.ChannelConfiguration = int32(bitReader!!.Read(4))
            asc.FrameLengthFlag = bitReader!!.Read(1) != uint32(0)
            asc.DependsOnCoreCoder = bitReader!!.Read(1) != uint32(0)
            return bitReader!!
        }
    }
}
