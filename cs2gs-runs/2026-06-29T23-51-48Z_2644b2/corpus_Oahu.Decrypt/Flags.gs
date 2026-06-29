package Oahu.Decrypt.Mpeg4.ID3

import System
import System.Linq

class Flags {
    private var flags []uint8

    init(flags ...uint8) {
        this.flags = flags
    }

    init(flags uint16) {
        this.flags = []uint8{uint8((flags >> 8)), uint8((flags & uint16(0xff)))}
    }

    prop Size int32 -> this.flags.Length

    prop this[index int32] bool {
        get {
            if index < 0 || index >= flags.Length * 8 {
                throw ArgumentOutOfRangeException(nameof(index), "Index must be within the range of the flags.")
            }
            return (int32(flags[index / 8]) & (1 << (7 - (index % 8)))) != 0
        }
        set {
            if index < 0 || index >= flags.Length * 8 {
                throw ArgumentOutOfRangeException(nameof(index), "Index must be within the range of the flags.")
            }
            if value {
                flags[index / 8] |= uint8((1 << (7 - (index % 8))))
            } else {
                flags[index / 8] &= uint8(^(1 << (7 - (index % 8))))
            }
        }
    }

    func ToBytes() []uint8 -> flags.ToArray()
}
