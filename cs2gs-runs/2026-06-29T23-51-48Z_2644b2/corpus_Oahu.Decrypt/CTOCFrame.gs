package Oahu.Decrypt.Mpeg4.ID3

import System.Collections.Generic
import System.IO
import System.Linq
import System.Text

class CTOCFrame : Frame {
    init(parent Frame, chapterFlags ChapterFlags, elementId string = "TOC1") : base(FrameHeader("CTOC", 0, parent.Version), parent) {
        ChildElementIDs = List[string]()
        ChapterFlags = chapterFlags
        ElementID = elementId
    }

    init(file Stream, header Header, parent Frame) : base(header, parent) {
        ChildElementIDs = List[string]()
        let endPosition = file.Position + int64(Header.Size)
        ElementID = Frame.ReadNullTerminatedString(file, false)
        ChapterFlags = ChapterFlags(file.ReadByte())
        let elemIdCount = file.ReadByte()
        for var i = 0; i < elemIdCount; i++ {
            ChildElementIDs.Add(Frame.ReadNullTerminatedString(file, false))
        }
        LoadChildren(file, endPosition)
    }

    override prop Size int32 -> Encoding.ASCII.GetByteCount(ElementID) + 3 + ChildElementIDs.Sum((c string) -> Encoding.ASCII.GetByteCount(c) + 1) + Children.Sum((c Frame) -> c.Size + c.Header.HeaderSize)

    prop ElementID string {
        get;
        init;
    }

    prop ChapterFlags ChapterFlags {
        get;
        init;
    }

    prop ChildElementIDs List[string] {
        get;
        init;
    }

    func Add(chapter CHAPFrame) -> ChildElementIDs.Add(chapter.ChapterID)

    override func Render(file Stream) {
        file.Write(Encoding.ASCII.GetBytes(ElementID))
        file.WriteByte(0)
        file.WriteByte(uint8(ChapterFlags))
        file.WriteByte(uint8(ChildElementIDs.Count))
        for ch in ChildElementIDs {
            file.Write(Encoding.ASCII.GetBytes(ch!!))
            file.WriteByte(0)
        }
    }
}
