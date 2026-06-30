package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class MdhdBox : HeaderBox {
    private var language string

    init(file Stream, header BoxHeader, parent IBox?) : base(file, header, parent) {
        let blob = file.ReadBlock(4)
        let reader = BitReader(blob!!)
        reader!!.Position = 1
        let c1 = char((reader!!.Read(5) + uint32(0x60)))
        let c2 = char((reader!!.Read(5) + uint32(0x60)))
        let c3 = char((reader!!.Read(5) + uint32(0x60)))
        language = string([]char{c1, c2, c3})
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(8)
    prop Timescale uint32

    prop Language string {
        get -> language
        set {
            if value.Length != 3 || value[0] < 'a' || value[0] > 'z' || value[1] < 'a' || value[1] > 'z' || value[2] < 'a' || value[2] > 'z' {
                throw ArgumentException("value must be three, lowercase ASCII characters", nameof(Language))
            }
            language = value
        }
    }

    protected open override func Render(file Stream) {
        base.Render(file)
        let writer = BitWriter()
        writer!!.Write(0, 1)
        writer!!.Write(uint32(Language[0]) - uint32(0x60), 5)
        writer!!.Write(uint32(Language[1]) - uint32(0x60), 5)
        writer!!.Write(uint32(Language[2]) - uint32(0x60), 5)
        writer!!.Write(0, 16)
        file.Write(writer!!.ToByteArray())
    }

    protected open override func ReadBeforeDuration(file Stream) {
        Timescale = file.ReadUInt32BE()
    }

    protected open override func WriteBeforeDuration(file Stream) {
        file.WriteUInt32BE(Timescale)
    }
}
