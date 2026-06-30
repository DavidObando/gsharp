package Oahu.Decrypt.Mpeg4.ID3

import System.IO

internal class EmptyFrame : Frame {
    convenience init(parent Frame) {
        init(FrameHeader(EmptyFrame.GetEmptyFrameId(parent.Version), 0, parent.Version), parent)
    }

    init(header Header, parent Frame) : base(header, parent) {
    }

    override func Render(file Stream) {
    }

    shared {
        func GetEmptyFrameSize(version int32) int32 -> if version == 0x200 { 6 } else { 10 }
        private func GetEmptyFrameId(version int32) string -> if version == 0x200 { "\u0000\u0000\u0000" } else { "\u0000\u0000\u0000\u0000" }
    }
}
