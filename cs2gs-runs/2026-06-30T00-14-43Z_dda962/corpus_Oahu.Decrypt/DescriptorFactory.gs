package Oahu.Decrypt.Mpeg4.Descriptors

import System.IO

class DescriptorFactory {
    shared {
        func CreateDescriptor(file Stream) BaseDescriptor {
            let header = DescriptorHeader(file)
            return switch header!!.TagID {
                case 3: ES_Descriptor(file, header!!)
                case 4: DecoderConfigDescriptor(file, header!!)
                case 5: AudioSpecificConfig(file, header!!)
                case 6: SLConfigDescriptor(file, header!!)
                default: UnknownDescriptor(file, header!!)
            }
        }
    }
}
