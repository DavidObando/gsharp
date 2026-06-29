package Oahu.Decrypt.Mpeg4.Boxes

import System.Diagnostics
import System.IO
import System.Linq
import Oahu.Decrypt.Mpeg4.Boxes.EC3SpecificBox
import Oahu.Decrypt.Mpeg4.Util

open class Dec3Box : Box {
    private let ec3Data []uint8

    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        ec3Data = file.ReadBlock(int32((header.TotalBoxSize - int64(header.HeaderSize))))
        let reader = BitReader(ec3Data)
        AverageBitrate = reader!!.Read(13) * uint32(1024)
        let num_ind_sub = reader!!.Read(3)
        Debug.Assert(num_ind_sub == uint32(0))
        IndependentSubstream = [int32(num_ind_sub + uint32(1))]Ec3IndependentSubstream
        for var i = 0; int64(i) <= int64(num_ind_sub); i++ {
            IndependentSubstream[i] = Ec3IndependentSubstream(reader!!)
        }
        let indSample = IndependentSubstream.First()
        Debug.Assert(indSample!!.NumDepSub == uint8(0))
        SampleRate = indSample!!.GetSampleRate()
        NumberOfChannels = indSample!!.ChannelCount()
        if reader!!.Length - reader!!.Position < 8 {
            return
        }
        reader!!.Position += 7
        FlagEc3ExtensionTypeA = reader!!.ReadBool()
        if FlagEc3ExtensionTypeA.Value {
            ComplexityIndexTypeA = uint8(reader!!.Read(8))
        }
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(ec3Data.Length)

    prop AverageBitrate uint32 {
        get;
        init;
    }

    prop SampleRate int32 {
        get;
        init;
    }

    prop NumberOfChannels int32 {
        get;
        init;
    }

    prop IndependentSubstream []Ec3IndependentSubstream {
        get;
        init;
    }

    prop IsAtmos bool -> FlagEc3ExtensionTypeA.HasValue

    prop FlagEc3ExtensionTypeA bool? {
        get;
        init;
    }

    prop ComplexityIndexTypeA uint8? {
        get;
        init;
    }

    protected open override func Render(file Stream) {
        file.Write(ec3Data)
    }
}
