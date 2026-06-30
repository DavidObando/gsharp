package Oahu.Decrypt.Mpeg4.ID3

import System
import System.IO

open class Header {
    open prop Identifier string {
        get;
    }

    prop Size int32 {
        get;
        init;
    }

    open prop HeaderSize int32 {
        get;
    }

    open func Render(stream Stream, renderSize int32, version uint16);
    func ToString() string -> if Identifier == "\u0000\u0000\u0000\u0000" { "\\0\\0\\0\\0" } else { if Identifier == "\u0000\u0000\u0000" { "\\0\\0\\0" } else { Identifier } }

    func SeekForwardToPosition(file Stream, endPos int64) {
        if file.Position < endPos {
            if file.CanSeek {
                file.Position = endPos
            } else {
                let buffer = [4096]uint8
                while file.Position < endPos {
                    let bytesToRead = Int32.Min(buffer!!.Length, int32((endPos - file.Position)))
                    file.ReadExactly(buffer!!, 0, bytesToRead)
                }
            }
        }
    }

    shared {
        func ReadUInt16BE(stream Stream) uint16 {
            let word = stackalloc [2]uint8
            stream.ReadExactly(word)
            return uint16((word[0] << 8 | int32(word[1])))
        }

        func UnSyncSafify(value uint32) int32 -> int32((((value & uint32(0x7f000000)) >> 3) | ((value & uint32(0x7f0000)) >> 2) | ((value & uint32(0x7f00)) >> 1) | (value & uint32(0x7f))))
        func SyncSafify(value int32) uint32 -> uint32((((value << 3) & 0x7f000000) | ((value << 2) & 0x7f0000) | ((value << 1) & 0x7f00) | (value & 0x7F)))

        func ReadUInt32BE(stream Stream) uint32 {
            let dword = stackalloc [4]uint8
            stream.ReadExactly(dword)
            return uint32((dword[0] << 24 | dword[1] << 16 | dword[2] << 8 | int32(dword[3])))
        }

        func ReadBlock(stream Stream, numBytes int32) []uint8 {
            let block = [numBytes]uint8
            stream.ReadExactly(block!!, 0, numBytes)
            return block!!
        }

        func WriteUInt32BE(stream Stream, value uint32) -> stream.Write([]uint8{uint8((value >> 24)), uint8((value >> 16)), uint8((value >> 8)), uint8(value)})
        func WriteUInt16BE(stream Stream, value uint32) -> stream.Write([]uint8{uint8((value >> 8)), uint8(value)})
    }
}
