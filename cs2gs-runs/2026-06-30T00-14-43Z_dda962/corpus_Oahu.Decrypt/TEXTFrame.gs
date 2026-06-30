package Oahu.Decrypt.Mpeg4.ID3

import System.IO
import System.Text

class TEXTFrame : Frame {
    init(file Stream, header Header, parent Frame) : base(header, parent) {
        EncodingFlag = uint8(file.ReadByte())
        Text = Frame.ReadSizeString(file, EncodingFlag == uint8(1), Header.Size - 1)
    }

    private init(header Header, parent Frame) : base(header, parent) {
    }

    override prop Size int32 -> 1 + (if Text == nil { 0 } else { if Frame.IsUnicode(Text!!) { Frame.UnicodeLength(Text!!) } else { Text!!.Length } })
    prop EncodingFlag uint8
    prop Text string?

    override func Render(file Stream) {
        if Text == nil {
            file.WriteByte(0)
        } else if Frame.IsUnicode(Text!!) {
            file.WriteByte(1)
            file.Write(Frame.UnicodeBytes(Text!!))
        } else {
            file.WriteByte(0)
            file.Write(Encoding.ASCII.GetBytes(Text!!))
        }
    }

    shared {
        func Create(parent Frame, frameId string, text string) TEXTFrame {
            let tit2 = TEXTFrame(FrameHeader(frameId, 0, parent.Version), parent)
            parent?.Children.Add(tit2!!)
            return tit2!!
        }
    }
}
