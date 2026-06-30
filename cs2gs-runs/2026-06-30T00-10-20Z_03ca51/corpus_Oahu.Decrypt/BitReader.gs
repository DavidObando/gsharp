package Oahu.Decrypt.Mpeg4.Util

import System
import System.Linq

class BitReader(bytes []uint8) {
    private var byteIndex int32 = 0
    private var bitIndex int32 = 0

    prop Position int32 {
        get -> byteIndex * 8 + bitIndex
        set {
            ArgumentOutOfRangeException.ThrowIfLessThan(value, 0, nameof(Position))
            ArgumentOutOfRangeException.ThrowIfGreaterThan(value, bytes.Length * 8, nameof(Position))
            byteIndex = value / 8
            bitIndex = value % 8
        }
    }

    prop Length int32 -> bytes.Length * 8
    func ReadBool() bool -> Read(1) != uint32(0)

    func ByteAlign() {
        let bitPad = Position % 8
        if bitPad != 0 {
            Position += 8 - bitPad
        }
    }

    func Read(numBits int32) uint32 {
        var numBits = numBits
        ArgumentOutOfRangeException.ThrowIfLessThan(numBits, 0, nameof(numBits))
        ArgumentOutOfRangeException.ThrowIfGreaterThan(numBits, 4 * 8, nameof(numBits))
        var value uint32 = uint32(0)
        while numBits > 0 {
            if byteIndex >= bytes.Length {
                throw InvalidOperationException("Not enough data to read the requested number of bits.")
            }
            let bitsToRead = Math.Min(numBits, 8 - bitIndex)
            let mask = (1u << bitsToRead) - uint32(1)
            value <<= bitsToRead
            value |= (uint32(bytes[byteIndex]) >> (8 - bitIndex - bitsToRead)) & mask
            numBits -= bitsToRead
            bitIndex += bitsToRead
            if bitIndex == 8 {
                byteIndex++
                bitIndex = 0
            }
        }
        return value
    }

    func CopyTo(writer BitWriter) {
        if bitIndex != 0 {
            let toRead = 8 - bitIndex
            let value = Read(toRead)
            writer.Write(value, toRead)
        }
        while byteIndex < bytes.Length {
            writer.Write(bytes[byteIndex], 8)
            byteIndex++
        }
    }
}

class BitWriter {
    private var byteIndex int32 = 0
    private var bitIndex int32 = 0
    private var bytes []uint8 = []uint8{}
    prop Position int32 -> byteIndex * 8 + bitIndex
    func ToByteArray() []uint8 -> bytes.ToArray()

    func Write(value uint32, numBits int32) {
        var value = value
        var numBits = numBits
        ArgumentOutOfRangeException.ThrowIfLessThan(numBits, 0, nameof(numBits))
        ArgumentOutOfRangeException.ThrowIfGreaterThan(numBits, 4 * 8, nameof(numBits))
        while numBits > 0 {
            if bitIndex == 0 {
                Array.Resize(&bytes, byteIndex + 1)
            }
            let bitsToWrite = Math.Min(numBits, 8 - bitIndex)
            value &= if numBits == 32 { UInt32.MaxValue } else { (1u << numBits) - uint32(1) }
            bytes[byteIndex] |= uint8(((value >> (numBits - bitsToWrite)) << (8 - bitIndex - bitsToWrite)))
            numBits -= bitsToWrite
            bitIndex += bitsToWrite
            if bitIndex == 8 {
                byteIndex++
                bitIndex = 0
            }
        }
    }
}
