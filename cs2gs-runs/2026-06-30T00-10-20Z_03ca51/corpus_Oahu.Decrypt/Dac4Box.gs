package Oahu.Decrypt.Mpeg4.Boxes

import System.IO
import Oahu.Decrypt.Mpeg4.Boxes.AC4SpecificBox
import Oahu.Decrypt.Mpeg4.Util

open class Dac4Box : Box {
    var Ac4DsiV1 Ac4DsiV1?
    private let ac4Data []uint8

    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        ac4Data = file.ReadBlock(int32((header.TotalBoxSize - int64(header.HeaderSize))))
        try {
            let reader = BitReader(ac4Data)
            Ac4DsiV1 = Ac4DsiV1(reader!!)
        } catch (ex Exception) {
            return
        }
        SampleRate = Ac4DsiV1.SampleRate()
        AverageBitrate = Ac4DsiV1.AverageBitrate()
        NumberOfChannels = (if Ac4DsiV1.Channels() != nil { Ac4Extensions.ChannelCount(Ac4DsiV1.Channels()!!) } else { nil })
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(ac4Data.Length)

    prop AverageBitrate uint32? {
        get;
        init;
    }

    prop SampleRate int32? {
        get;
        init;
    }

    prop NumberOfChannels int32? {
        get;
        init;
    }

    protected open override func Render(file Stream) {
        file.Write(ac4Data)
    }
}
