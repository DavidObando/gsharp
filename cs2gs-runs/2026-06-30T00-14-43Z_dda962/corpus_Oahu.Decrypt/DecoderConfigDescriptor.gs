package Oahu.Decrypt.Mpeg4.Descriptors

import System.IO
import Oahu.Decrypt.Mpeg4.Util

class DecoderConfigDescriptor : BaseDescriptor {
    private let blob []uint8

    init(file Stream, header DescriptorHeader) : base(file, header) {
        ObjectTypeIndication = uint8(file.ReadByte())
        blob = file.ReadBlock(4)
        MaxBitrate = file.ReadUInt32BE()
        AverageBitrate = file.ReadUInt32BE()
        LoadChildren(file)
    }

    private init(objectTypeIndication uint8, blob []uint8) : base(4) {
        ObjectTypeIndication = objectTypeIndication
        this.blob = blob
    }

    prop ObjectTypeIndication uint8 {
        get;
        init;
    }

    prop MaxBitrate uint32
    prop AverageBitrate uint32
    prop AudioSpecificConfig AudioSpecificConfig -> GetChildOrThrow[AudioSpecificConfig]()
    override prop InternalSize int32 -> base.InternalSize + 13

    override func Render(file Stream) {
        file.WriteByte(ObjectTypeIndication)
        file.Write(blob)
        file.WriteUInt32BE(MaxBitrate)
        file.WriteUInt32BE(AverageBitrate)
    }

    shared {
        func CreateAudio() DecoderConfigDescriptor {
            let descriptor = DecoderConfigDescriptor(0x40, []uint8{uint8(0x15), uint8(0x00), uint8(0x00), uint8(0x00)})
            let asc = AudioSpecificConfig.CreateEmpty()
            descriptor!!.Children.Add(asc!!)
            return descriptor!!
        }
    }
}
