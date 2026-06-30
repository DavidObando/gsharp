package Oahu.Decrypt.Mpeg4.ID3

import System.IO
import System.Text

class APICFrame : Frame {
    init(file Stream, header Header, parent Frame) : base(header, parent) {
        let startPos = file.Position
        let textEncoding = file.ReadByte()
        ImageFormat = Frame.ReadNullTerminatedString(file, false)
        Description = Frame.ReadNullTerminatedString(file, textEncoding == 1)
        Type = uint8(file.ReadByte())
        Image = [int32((startPos + int64(header.Size) - file.Position))]uint8
        file.ReadExactly(Image)
    }

    override prop Size int32 {
        get {
            let fixedSize = 1 + ImageFormat.Length + 1 + 1 + Image.Length
            if Frame.IsUnicode(Description) {
                return Frame.UnicodeLength(Description) + 2 + fixedSize
            } else {
                return Description.Length + 1 + fixedSize
            }
        }
    }

    prop ImageFormat string
    prop Description string
    prop Type uint8
    prop Image []uint8

    override func Render(file Stream) {
        let txtFormat = if Frame.IsUnicode(Description) { 1 } else { 0 }
        file.WriteByte(uint8(txtFormat))
        file.Write(Encoding.ASCII.GetBytes(ImageFormat))
        file.WriteByte(0)
        file.WriteByte(Type)
        if txtFormat == 0 {
            file.Write(Encoding.ASCII.GetBytes(Description))
            file.WriteByte(0)
        } else {
            file.Write(Frame.UnicodeBytes(Description))
            file.Write(stackalloc [2]uint8)
        }
        file.Write(Image)
    }
}
