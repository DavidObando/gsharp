package Oahu.Decrypt.Mpeg4.ID3

import System
import System.IO
import System.Text

class FrameHeader : Header {
    init(frameID string, flags uint16, version uint16, size int32 = 0) {
        Version = version
        Identifier = frameID
        Flags = Flags(flags)
        Size = size
    }

    override prop Identifier string {
        get;
        init;
    }

    prop Flags Flags {
        get;
        init;
    }

    override prop HeaderSize int32 -> if Version == uint16(0x200) { 6 } else { 10 }

    prop Version uint16 {
        get;
        init;
    }

    override func Render(stream Stream, renderSize int32, version uint16) {
        stream.Write(Encoding.ASCII.GetBytes(Identifier))
        let size = if version >= uint16(0x400) { int32(Header.SyncSafify(renderSize)) } else { renderSize }
        if version == uint16(0x200) {
            stream.WriteByte(uint8((size >> 16)))
            stream.WriteByte(uint8((size >> 8)))
            stream.WriteByte(uint8(size))
        } else {
            Header.WriteUInt32BE(stream, uint32(size))
            stream.Write(Flags.ToBytes())
        }
    }

    shared {
        func Create(file Stream, version uint16) FrameHeader {
            let originalPosition = file.Position
            if version == uint16(0x200) {
                let bts2 = stackalloc [6]uint8
                file.ReadExactly(bts2)
                let frameID = Encoding.ASCII.GetString(bts2.Slice(0, 3))
                let size = (bts2[3] << 16) | (bts2[4] << 8) | int32(bts2[5])
                return FrameHeader(frameID!!, 0, version, size)
            } else {
                let bts = stackalloc [4]uint8
                file.ReadExactly(bts)
                let frameID = Encoding.ASCII.GetString(bts)
                let size = if version >= uint16(0x400) { Header.UnSyncSafify(Header.ReadUInt32BE(file)) } else { int32(Header.ReadUInt32BE(file)) }
                return FrameHeader(frameID!!, Header.ReadUInt16BE(file), version, size)
            }
        }
    }
}
