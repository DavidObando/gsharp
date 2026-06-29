package Oahu.Decrypt.Mpeg4.Boxes

import System.IO
import Oahu.Decrypt.Mpeg4.Descriptors

open class EsdsBox : FullBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        let descroptor = DescriptorFactory.CreateDescriptor(file)
        ES_Descriptor = descroptor as ES_Descriptor ?? throw InvalidDataException("${descroptor!!.GetType()} is not an ${nameof(ES_Descriptor)}")
    }

    private init(es_Descriptor ES_Descriptor, parent IBox) : base([]uint8{uint8(0), uint8(0), uint8(0), uint8(0)}, BoxHeader(8, "esds"), parent) {
        ES_Descriptor = es_Descriptor
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(ES_Descriptor.RenderSize)

    prop ES_Descriptor ES_Descriptor {
        get;
        init;
    }

    protected open override func Render(file Stream) {
        base.Render(file)
        ES_Descriptor.Save(file)
    }

    shared {
        func CreateEmpty(parent IBox) EsdsBox {
            let esds = EsdsBox(ES_Descriptor.CreateAudio(), parent)
            parent.Children.Add(esds!!)
            return esds!!
        }
    }
}
