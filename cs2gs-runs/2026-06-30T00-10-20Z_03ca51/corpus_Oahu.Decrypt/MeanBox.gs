package Oahu.Decrypt.Mpeg4.Boxes

import System.Diagnostics
import System.IO
import System.Text
import Oahu.Decrypt.Mpeg4.Util

@DebuggerDisplay("{DebuggerDisplay,nq}")
open class MeanBox : FullBox {
    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        let stringSize = RemainingBoxLength(file)
        let stringData = file.ReadBlock(int32(stringSize))
        ReverseDnsDomain = Encoding.UTF8.GetString(stringData!!)
    }

    private init(header BoxHeader, parent IBox?, domain string) : base([4]uint8, header, parent) {
        ReverseDnsDomain = domain
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(Encoding.UTF8.GetByteCount(ReverseDnsDomain))
    prop ReverseDnsDomain string
    private prop DebuggerDisplay string -> "domain: $ReverseDnsDomain"

    protected open override func Render(file Stream) {
        base.Render(file)
        file.Write(Encoding.UTF8.GetBytes(ReverseDnsDomain))
    }

    shared {
        func Create(parent IBox?, domain string) MeanBox {
            let size = Encoding.UTF8.GetByteCount(domain) + 12
            let header = BoxHeader(uint32(size), "mean")
            let meanBox = MeanBox(header, parent, domain)
            parent?.Children.Add(meanBox)
            return meanBox
        }
    }
}
