package Oahu.Decrypt.Mpeg4.ID3

import System.IO
import System.Text

class TXXXFrame : Frame {
    init(file Stream, header Header, parent Frame) : base(header, parent) {
        let startPos = file.Position
        let unicode = file.ReadByte() == 1
        FieldName = Frame.ReadNullTerminatedString(file, unicode)
        FieldValue = Frame.ReadSizeString(file, unicode, int32((startPos + int64(header.Size) - file.Position)))
    }

    override prop Size int32 -> if Frame.IsUnicode(FieldName) || Frame.IsUnicode(FieldValue) { 1 + Frame.UnicodeLength(FieldName) + 2 + Frame.UnicodeLength(FieldValue) } else { 1 + FieldName.Length + 1 + FieldValue.Length }

    prop FieldName string {
        get;
        init;
    }

    prop FieldValue string {
        get;
        init;
    }

    func ToString() string -> FieldName

    override func Render(file Stream) {
        if Frame.IsUnicode(FieldName) || Frame.IsUnicode(FieldValue) {
            file.WriteByte(1)
            file.Write(Frame.UnicodeBytes(FieldName))
            file.Write(stackalloc [2]uint8)
            file.Write(Frame.UnicodeBytes(FieldValue))
        } else {
            file.WriteByte(0)
            file.Write(Encoding.ASCII.GetBytes(FieldName))
            file.WriteByte(0)
            file.Write(Encoding.ASCII.GetBytes(FieldValue))
        }
    }
}
