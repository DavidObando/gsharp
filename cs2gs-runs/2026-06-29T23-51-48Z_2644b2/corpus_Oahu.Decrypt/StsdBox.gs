package Oahu.Decrypt.Mpeg4.Boxes

import System.Collections.Generic
import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class StsdBox : FullBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        VisualSampleEntries = List[VisualSampleEntry]()
        EntryCount = file.ReadUInt32BE()
        let hdlr HdlrBox? = Parent?.Parent?.Parent?.GetChild[HdlrBox]()
        for var i = 0; int64(i) < int64(EntryCount); i++ {
            let h = BoxHeader(file)
            if hdlr?.HandlerType == "soun" {
                AudioSampleEntry = AudioSampleEntry(file, h, this)
                Children.Add(AudioSampleEntry!!)
            } else if hdlr?.HandlerType == "vide" {
                let entry = VisualSampleEntry(file, h, this)
                VisualSampleEntries.Add(entry!!)
                Children.Add(entry!!)
            } else {
                let unknownSampleEntry = UnknownBox(file, h, this)
                Children.Add(unknownSampleEntry)
            }
        }
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(4)

    prop EntryCount uint32 {
        get;
        init;
    }

    prop AudioSampleEntry AudioSampleEntry? {
        get;
        init;
    }

    prop VisualSampleEntries List[VisualSampleEntry] {
        get;
        init;
    }

    protected open override func Render(file Stream) {
        base.Render(file)
        file.WriteUInt32BE(EntryCount)
    }
}
