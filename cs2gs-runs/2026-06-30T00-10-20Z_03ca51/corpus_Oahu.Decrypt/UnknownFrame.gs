package Oahu.Decrypt.Mpeg4.ID3

import System.IO
import System.Text

class UnknownFrame : Frame {
    init(file Stream, header Header, parent Frame) : base(header, parent) {
        Blob = [header.Size]uint8
        file.ReadExactly(Blob)
    }

    override prop Size int32 -> Blob.Length

    prop Blob []uint8 {
        get;
        init;
    }

    prop DataText string -> if Blob.Length == 0 { "" } else { (if Blob[0] == uint8(0) { Encoding.ASCII } else { Encoding.Unicode }).GetString(Blob, 1, Blob.Length - 1) }
    override func Render(file Stream) -> file.Write(Blob)
}
