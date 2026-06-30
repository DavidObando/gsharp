package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.Collections.Generic
import System.IO
import System.Linq

open class MoovBox : Box {
    init(file Stream, header BoxHeader) : base(header, nil) {
        LoadChildren(file)
    }

    prop Mvhd MvhdBox -> GetChildOrThrow[MvhdBox]()
    prop AudioTrack TrakBox -> Tracks.Where((t TrakBox) -> t.GetChild[MdiaBox]()?.GetChild[HdlrBox]()?.HandlerType == "soun").First()
    prop VideoTrack TrakBox? -> Tracks.Where((t TrakBox) -> t.GetChild[MdiaBox]()?.GetChild[HdlrBox]()?.HandlerType == "vide").FirstOrDefault()
    prop TextTrack TrakBox? -> Tracks.Where((t TrakBox) -> t.GetChild[MdiaBox]()?.GetChild[HdlrBox]()?.HandlerType == "text").FirstOrDefault()
    prop ILst AppleListBox? -> GetChild[UdtaBox]()?.GetChild[MetaBox]()?.GetChild[AppleListBox]()
    prop Tracks IEnumerable[TrakBox] -> GetChildren[TrakBox]()

    func ShiftChunkOffsets(shiftVector int64) {
        for track in Tracks {
            var coBox = track!!.Mdia.Minf.Stbl.COBox
            let offsets = coBox.ChunkOffsets
            var requires64Bit = false
            for var i = 0; i < offsets.Count; i++ {
                let offset = offsets.GetOffsetAtIndex(i)
                let newOffset = offset + shiftVector
                requires64Bit |= newOffset > int64(UInt32.MaxValue)
                offsets.SetOffsetAtIndex(i, newOffset)
            }
            if requires64Bit && coBox is StcoBox {
                track!!.Mdia.Minf.Stbl.Children.Remove(coBox)
                coBox = Co64Box.CreateBlank(track!!.Mdia.Minf.Stbl, offsets)
            } else if !requires64Bit && coBox is Co64Box {
                track!!.Mdia.Minf.Stbl.Children.Remove(coBox)
                coBox = StcoBox.CreateBlank(track!!.Mdia.Minf.Stbl, offsets)
            }
        }
    }

    func ShiftChunkOffsetsWithMoovInFront(shiftVector int64) int64 {
        var shiftVector = shiftVector
        var shifted int64 = 0
        do {
            let moovSize = RenderSize
            ShiftChunkOffsets(shiftVector)
            shifted += shiftVector
            shiftVector = RenderSize - moovSize
        } while shiftVector != int64(0)
        return shifted
    }

    func CreateEmptyMetadata() AppleListBox {
        let ilist AppleListBox? = ILst as AppleListBox
        if ilist != nil {
            return ilist
        } else {
            let udata = UdtaBox.CreateEmpty(this)
            let meta = MetaBox.CreateEmpty(udata!!)
            let hdlr = HdlrBox.Create("mdir", nil, []uint8{uint8(0x61), uint8(0x70), uint8(0x70), uint8(0x6c)}, meta!!)
            return AppleListBox.CreateEmpty(meta!!)
        }
    }

    func CreateEmptyTextTrack() TrakBox {
        let txt TrakBox? = TextTrack as TrakBox
        if txt != nil {
            return txt
        } else {
            using let ms = MemoryStream(MoovBox.EmptyTextTrack)
            let textTrack = BoxFactory.CreateBox[TrakBox](ms!!, nil)
            Children.Insert(Children.IndexOf(AudioTrack) + 1, textTrack!!)
            textTrack!!.Tkhd.TrackID = Mvhd.NextTrackID
            Mvhd.NextTrackID++
            let references = GetChildren[TrakBox]().Except([]TrakBox{AudioTrack}).Select((t TrakBox) -> t.Tkhd.TrackID).Order().ToHashSet()
            let tref TrefBox? = AudioTrack.GetChild[TrefBox]() as TrefBox
            if tref != nil {
                let referenceType ITrackReferenceTypeBox? = tref.References.FirstOrDefault((r ITrackReferenceTypeBox) -> r.Header.Type == "chap") as ITrackReferenceTypeBox
                if referenceType != nil {
                    referenceType!!.TrackIds = references
                } else {
                    tref.AddReference("chap", references)
                }
            } else {
                TrefBox.CreatEmpty(AudioTrack).AddReference("chap", references)
            }
            textTrack!!.Mdia.Mdhd.ModificationTime = DateTimeOffset.UtcNow
            textTrack!!.Mdia.Mdhd.CreationTime = textTrack!!.Mdia.Mdhd.ModificationTime
            textTrack!!.Tkhd.ModificationTime = textTrack!!.Mdia.Mdhd.CreationTime
            textTrack!!.Tkhd.CreationTime = textTrack!!.Tkhd.ModificationTime
            textTrack!!.Mdia.Mdhd.Timescale = AudioTrack.Mdia.Mdhd.Timescale
            return textTrack!!
        }
    }

    protected open override func Render(file Stream) {
        return
    }

    shared {
        private let EmptyTextTrack []uint8 = []uint8{uint8(0x00), uint8(0x00), uint8(0x02), uint8(0x11), uint8(0x74), uint8(0x72), uint8(0x61), uint8(0x6b), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x5c), uint8(0x74), uint8(0x6b), uint8(0x68), uint8(0x64), uint8(0x00), uint8(0x00), uint8(0x10), uint8(0x01), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x01), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x01), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x01), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x40), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0xa0), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0xa0), uint8(0x00), uint8(0x00), uint8(0x01), uint8(0x70), uint8(0x6d), uint8(0x64), uint8(0x69), uint8(0x61), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x20), uint8(0x6d), uint8(0x64), uint8(0x68), uint8(0x64), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x35), uint8(0x33), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x39), uint8(0x68), uint8(0x64), uint8(0x6c), uint8(0x72), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x6d), uint8(0x68), uint8(0x6c), uint8(0x72), uint8(0x74), uint8(0x65), uint8(0x78), uint8(0x74), uint8(0x61), uint8(0x70), uint8(0x70), uint8(0x6c), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x18), uint8(0x41), uint8(0x70), uint8(0x70), uint8(0x6c), uint8(0x65), uint8(0x20), uint8(0x54), uint8(0x65), uint8(0x78), uint8(0x74), uint8(0x20), uint8(0x4d), uint8(0x65), uint8(0x64), uint8(0x69), uint8(0x61), uint8(0x20), uint8(0x48), uint8(0x61), uint8(0x6e), uint8(0x64), uint8(0x6c), uint8(0x65), uint8(0x72), uint8(0x00), uint8(0x00), uint8(0x01), uint8(0x0f), uint8(0x6d), uint8(0x69), uint8(0x6e), uint8(0x66), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x4c), uint8(0x67), uint8(0x6d), uint8(0x68), uint8(0x64), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x18), uint8(0x67), uint8(0x6d), uint8(0x69), uint8(0x6e), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x40), uint8(0x80), uint8(0x00), uint8(0x80), uint8(0x00), uint8(0x80), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x2c), uint8(0x74), uint8(0x65), uint8(0x78), uint8(0x74), uint8(0x00), uint8(0x01), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x01), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x40), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x24), uint8(0x64), uint8(0x69), uint8(0x6e), uint8(0x66), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x1c), uint8(0x64), uint8(0x72), uint8(0x65), uint8(0x66), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x01), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x0c), uint8(0x61), uint8(0x6c), uint8(0x69), uint8(0x73), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x01), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x97), uint8(0x73), uint8(0x74), uint8(0x62), uint8(0x6c), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x4b), uint8(0x73), uint8(0x74), uint8(0x73), uint8(0x64), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x01), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x3b), uint8(0x74), uint8(0x65), uint8(0x78), uint8(0x74), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x01), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x01), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x01), uint8(0xff), uint8(0xff), uint8(0xff), uint8(0xff), uint8(0xff), uint8(0xff), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x10), uint8(0x73), uint8(0x74), uint8(0x74), uint8(0x73), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x10), uint8(0x73), uint8(0x74), uint8(0x73), uint8(0x63), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x10), uint8(0x73), uint8(0x74), uint8(0x63), uint8(0x6f), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x14), uint8(0x73), uint8(0x74), uint8(0x73), uint8(0x7a), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x3d), uint8(0x75), uint8(0x64), uint8(0x74), uint8(0x61), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x35), uint8(0x6d), uint8(0x65), uint8(0x74), uint8(0x61), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x21), uint8(0x68), uint8(0x64), uint8(0x6c), uint8(0x72), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x6d), uint8(0x64), uint8(0x69), uint8(0x72), uint8(0x61), uint8(0x70), uint8(0x70), uint8(0x6c), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x00), uint8(0x08), uint8(0x69), uint8(0x6c), uint8(0x73), uint8(0x74)}
    }
}
