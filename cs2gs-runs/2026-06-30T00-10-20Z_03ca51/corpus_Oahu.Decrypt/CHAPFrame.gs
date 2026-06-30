package Oahu.Decrypt.Mpeg4.ID3

import System
import System.IO
import System.Linq
import System.Text

enum ChapterFlags { TopLevel, Ordered }

class CHAPFrame : Frame {
    init(parent Frame, startTime TimeSpan, endTime TimeSpan, chNum int32, title string, subtitle string? = nil, subtitle2 string? = nil) : base(FrameHeader("CHAP", 0, parent.Version), parent) {
        ChapterID = title
        StartTime = startTime
        EndTime = endTime
        ByteStart = UInt32.MaxValue
        ByteEnd = UInt32.MaxValue
        if subtitle != nil {
            TEXTFrame.Create(this, "TIT2", subtitle!!)
        }
        if subtitle2 != nil {
            TEXTFrame.Create(this, "TIT3", subtitle2!!)
        }
    }

    init(file Stream, header Header, parent Frame) : base(header, parent) {
        let endPosition = file.Position + int64(Header.Size)
        ChapterID = Frame.ReadNullTerminatedString(file, false)
        StartTime = TimeSpan.FromMilliseconds(Header.ReadUInt32BE(file))
        EndTime = TimeSpan.FromMilliseconds(Header.ReadUInt32BE(file))
        ByteStart = Header.ReadUInt32BE(file)
        ByteEnd = Header.ReadUInt32BE(file)
        LoadChildren(file, endPosition)
    }

    override prop Size int32 -> Encoding.ASCII.GetByteCount(ChapterID) + 1 + 4 * 4 + Children.Sum((c Frame) -> c.Size + 10)
    prop ChapterID string
    prop StartTime TimeSpan
    prop EndTime TimeSpan
    prop ByteStart uint32
    prop ByteEnd uint32

    override func Render(file Stream) {
        file.Write(Encoding.ASCII.GetBytes(ChapterID))
        file.WriteByte(0)
        Header.WriteUInt32BE(file, uint32(Math.Round(StartTime.TotalMilliseconds)))
        Header.WriteUInt32BE(file, uint32(Math.Round(EndTime.TotalMilliseconds)))
        Header.WriteUInt32BE(file, ByteStart)
        Header.WriteUInt32BE(file, ByteEnd)
    }
}
