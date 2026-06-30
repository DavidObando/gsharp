package Oahu.Decrypt.Mpeg4.Boxes

import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Oahu.Decrypt.Mpeg4.Util

interface ITrackReferenceTypeBox : IBox {
    prop TrackIds HashSet[uint32]
}

open class TrefBox : Box {
    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        References = List[ITrackReferenceTypeBox]()
        while RemainingBoxLength(file) > int64(0) {
            References.Add(TrackReferenceTypeBox(file, this))
        }
    }

    private init(parent IBox) : base(BoxHeader(8, "tref"), parent) {
        References = List[ITrackReferenceTypeBox]()
    }

    open override prop RenderSize int64 -> base.RenderSize + References.Sum((r ITrackReferenceTypeBox) -> r.RenderSize)

    prop References List[ITrackReferenceTypeBox] {
        get;
        init;
    }

    func AddReference(type_ string, trackIds HashSet[uint32]) TrefBox {
        References.Add(TrackReferenceTypeBox(type_, trackIds, this))
        return this
    }

    protected open override func Render(file Stream) {
        for box in References {
            box!!.Save(file)
        }
    }

    @DebuggerDisplay("{Header.Type,nq}, {TrackIds}")
    private open class TrackReferenceTypeBox : Box, ITrackReferenceTypeBox {
        init(file Stream, parent IBox?) : base(BoxHeader(file), parent) {
            let numTraks = int32(RemainingBoxLength(file)) / 4
            TrackIds = HashSet[uint32](numTraks)
            for var i = 0; i < numTraks; i++ {
                TrackIds.Add(file.ReadUInt32BE())
            }
        }

        init(type_ string, trackIds HashSet[uint32], parent IBox) : base(BoxHeader(12, type_), parent) {
            TrackIds = trackIds
        }

        open override prop RenderSize int64 -> base.RenderSize + int64(4 * TrackIds.Count)
        prop TrackIds HashSet[uint32]

        protected open override func Render(file Stream) {
            for id in TrackIds {
                file.WriteUInt32BE(id)
            }
        }
    }

    shared {
        func CreatEmpty(parent IBox) TrefBox {
            let tref = TrefBox(parent)
            parent.Children.Add(tref!!)
            return tref!!
        }
    }
}
