package Oahu.Decrypt.Mpeg4.ID3

import System.IO

class Id3ExtendedHeader : Frame {
    private init(header Header, parent Frame) : base(header, parent) {
    }

    override func Render(file Stream) {
    }

    shared {
        func Create(file Stream, parent Id3Tag) Id3ExtendedHeader {
            let header = ExtendedHeader(file, parent.Version)
            return Id3ExtendedHeader(header!!, parent)
        }
    }
}

class ExtendedHeader : Header {
    init(file Stream, version int32) {
        Identifier = String.Empty
        Version = version
        var headerSize int64
        let originalPosition = file.Position
        if version >= 0x400 {
            headerSize = Header.UnSyncSafify(Header.ReadUInt32BE(file))
            let numFlagBytes = file.ReadByte()
            ExtendedFlags = Flags(Header.ReadBlock(file, numFlagBytes))
            if (ExtendedFlags!![1]) {
                TagIsUpdate = file.ReadByte() != 0
            }
            if ExtendedFlags!![2] && file.ReadByte() == 5 {
                CRC32 = (uint32(file.ReadByte()) << 28) | uint32(Header.UnSyncSafify(Header.ReadUInt32BE(file)))
            }
            if ExtendedFlags!![3] && file.ReadByte() == 1 {
                TagRestrictions = uint8(file.ReadByte())
            }
        } else {
            headerSize = Header.ReadUInt32BE(file)
            ExtendedFlags = Flags(Header.ReadUInt16BE(file))
            SizeOfPadding = Header.ReadUInt32BE(file)
            if (ExtendedFlags!![0]) {
                CRC32 = Header.ReadUInt32BE(file)
            }
        }
        SeekForwardToPosition(file, originalPosition + headerSize)
    }

    override prop Identifier string {
        get;
        init;
    }

    override prop HeaderSize int32 -> GetExtendedFlagsSize()
    prop ExtendedFlags Flags?
    prop SizeOfPadding uint32
    prop TagIsUpdate bool
    prop TagRestrictions uint8
    prop CRC32 uint32

    prop Version int32 {
        get;
        init;
    }

    override func Render(stream Stream, renderSize int32, version uint16) {
        if version >= uint16(0x400) {
            Header.WriteUInt32BE(stream, Header.SyncSafify(HeaderSize + renderSize))
            stream.WriteByte(uint8(ExtendedFlags!!.Size))
            stream.Write(ExtendedFlags!!.ToBytes())
            if (ExtendedFlags!![1]) {
                stream.WriteByte(uint8((if TagIsUpdate { 1 } else { 0 })))
            }
            if (ExtendedFlags!![2]) {
                stream.WriteByte(5)
                stream.WriteByte(uint8((CRC32 >> 28)))
                Header.WriteUInt32BE(stream, Header.SyncSafify(int32((CRC32 & uint32(0xfffffff)))))
            }
            if (ExtendedFlags!![3]) {
                stream.WriteByte(1)
                stream.WriteByte(TagRestrictions)
            }
        } else {
            Header.WriteUInt32BE(stream, uint32((HeaderSize + renderSize)))
            stream.Write(ExtendedFlags!!.ToBytes())
            Header.WriteUInt32BE(stream, SizeOfPadding)
            if (ExtendedFlags!![0]) {
                Header.WriteUInt32BE(stream, CRC32)
            }
        }
    }

    func ToString() string -> "ExtendedHeader"

    private func GetExtendedFlagsSize() int32 {
        if ExtendedFlags == nil {
            return 0
        }
        if Version >= 0x400 {
            var size = 5 + ExtendedFlags!!.Size
            if (ExtendedFlags!![1]) {
                size++
            }
            if (ExtendedFlags!![2]) {
                size += 6
            }
            if (ExtendedFlags!![3]) {
                size += 2
            }
            return size
        } else {
            return if ExtendedFlags!![0] { 10 } else { 6 }
        }
    }
}
