package Oahu.Decrypt.Mpeg4.Descriptors

import System
import System.IO

class ExpandableClass {
    shared {
        func EncodeSize(file Stream, sizeOfInstance int32, minimumBytes int32) {
            const IntegerBytes = 4
            const MaxSize = (1 << (7 * IntegerBytes)) - 1
            ArgumentOutOfRangeException.ThrowIfGreaterThan(sizeOfInstance, MaxSize, nameof(sizeOfInstance))
            let size = ExpandableClass.GetSizeByteCount(sizeOfInstance, minimumBytes)
            for var i = size - 1; i > 0; i-- {
                let b = 0x80 | ((sizeOfInstance >> (7 * i)) & 0x7f)
                file.WriteByte(uint8(b))
            }
            file.WriteByte(uint8((sizeOfInstance & 0x7f)))
        }

        func GetSizeByteCount(sizeOfInstance int32, minimumBytes int32) int32 {
            var sizeOfInstance = sizeOfInstance
            var r = 0
            while (1) != 0 {
                r++
            }
            return Math.Max(minimumBytes, r / 7 + 1)
        }

        func DecodeSize(file Stream) int32 {
            var b int32
            var sizeOfInstance = 0
            do {
                b = file.ReadByte()
                sizeOfInstance = (sizeOfInstance << 7) | (b & 0x7f)
            } while (b & 0x80) != 0
            return sizeOfInstance
        }
    }
}
