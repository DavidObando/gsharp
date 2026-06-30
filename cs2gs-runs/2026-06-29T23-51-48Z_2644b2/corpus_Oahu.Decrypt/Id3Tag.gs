package Oahu.Decrypt.Mpeg4.ID3

import System.IO
import System.Linq

class Id3Tag : Frame {
    private init(file Stream, header Id3Header) : base(header, default(Frame)) {
        let endPosition = file.Position + int64(Header.Size)
        Id3Header = header
        if (Id3Header.Flags[1]) {
            Children.Add(Id3ExtendedHeader.Create(file, this))
        }
        LoadChildren(file, endPosition)
    }

    override prop Size int32 -> Children.Sum((f Frame) -> f.Size + f.Header.HeaderSize) + EmptyFrame.GetEmptyFrameSize(Version)
    override prop Version uint16 -> Id3Header.Version

    private prop Id3Header Id3Header {
        get;
        init;
    }

    func Save(file Stream) {
        Save(file, Id3Header.Version)
        EmptyFrame(this).Save(file, Id3Header.Version)
    }

    func Add(frame Frame) -> Children.Add(frame)

    override func Render(file Stream) {
    }

    shared {
        func Create(file Stream) Id3Tag? {
            let id3Header = Id3Header.Create(file)
            if id3Header == nil || !((id3Header!!.Version == uint16(0x200) || id3Header!!.Version == uint16(0x300) || id3Header!!.Version == uint16(0x400))) {
                return nil
            }
            try {
                return Id3Tag(file, id3Header!!)
            } catch (ex Exception) {
                return nil
            }
        }
    }
}
