package Oahu.Decrypt.Mpeg4.Util

import System

class ByteUtil {
    shared {
        func BytesFromHexString(hexString string) []uint8 {
            let byteCount = hexString.Length / 2
            let bytes = [byteCount]uint8
            for var i = 0; i < byteCount; i++ {
                bytes[i] = Byte.Parse(hexString.Substring(2 * i, 2), System.Globalization.NumberStyles.HexNumber)
            }
            return bytes
        }

        func CloneBytes(src []uint8) []uint8 {
            return ByteUtil.CloneBytes(src, 0, src.Length)
        }

        func CloneBytes(src []uint8, srcOffset int32, count int32) []uint8 {
            let dst = [count]uint8
            Buffer.BlockCopy(src, srcOffset, dst, 0, count)
            return dst
        }

        func BytesEqual(array1 []uint8, array2 []uint8, reverseDirection bool = false) bool {
            return ByteUtil.BytesEqual(array1, 0, array2, 0, array1.Length, reverseDirection)
        }

        func BytesEqual(array1 []uint8, startIndex1 int32, array2 []uint8, startIndex2 int32, count int32, reverseDirection bool = false) bool {
            if array1.Length < startIndex1 + count || array2.Length < startIndex2 + count {
                return false
            }
            let indexDiff = startIndex2 - startIndex1
            for var i = startIndex1; i < startIndex1 + count; i++ {
                let array2Index = if reverseDirection { startIndex2 + count - 1 - (i - startIndex1) } else { i + indexDiff }
                if (array1[i] != array2[array2Index]) {
                    return false
                }
            }
            return true
        }
    }
}
