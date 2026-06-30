package Oahu.Decrypt.Mpeg4.ID3

import System
import System.IO

class Id3Header : Header {
    internal init(version uint16, file Stream) {
        Version = version
        Flags = Flags(uint8(file.ReadByte()))
        Size = Header.UnSyncSafify(Header.ReadUInt32BE(file))
    }

    override prop Identifier string -> "ID3"
    prop Version uint16
    prop Flags Flags
    override prop HeaderSize int32 -> 10

    override func Render(stream Stream, renderSize int32, version uint16) {
        stream.Write([]uint8{0x49, 0x44, 0x33})
        stream.WriteByte(uint8((version >> 8)))
        stream.WriteByte(uint8((version & uint16(0xff))))
        stream.Write(Flags.ToBytes())
        Header.WriteUInt32BE(stream, Header.SyncSafify(renderSize))
    }

    shared {
        func Create(file Stream) Id3Header? {
            try {
                let bts = stackalloc [4]uint8
                file.ReadExactly(bts)
                if bts[0] == uint8('I') && bts[1] == uint8('D') && bts[2] == uint8('3') && bts[3] == uint8(2) || bts[3] == uint8(3) || bts[3] == uint8(4) {
                    let version = uint16((bts[3] << 8 | file.ReadByte()))
                    return Id3Header(version, file)
                }
                return nil
            } catch (ex Exception) {
                return nil
            }
        }
    }
}
