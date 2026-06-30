package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.IO
import System.Text
import Oahu.Decrypt.Mpeg4.Util

class BoxHeader {
    init(file Stream) {
        FilePosition = file.Position
        TotalBoxSize = file.ReadUInt32BE()
        Type = file.ReadType()
        HeaderSize = uint32(8)
        if TotalBoxSize == int64(1) {
            Version = 1
            TotalBoxSize = file.ReadInt64BE()
            HeaderSize += uint32(uint32(8))
        }
    }

    init(boxSize int64, boxType string) {
        if boxSize < int64(8) {
            throw ArgumentException("${nameof(boxSize)} must be at least 8 bytes.")
        }
        if String.IsNullOrEmpty(boxType) || Encoding.ASCII.GetByteCount(boxType) != 4 {
            throw ArgumentException("${nameof(boxType)} must be a 4-byte long ASCII string.")
        }
        FilePosition = 0
        Version = if boxSize > int64(UInt32.MaxValue) { 1 } else { 0 }
        TotalBoxSize = boxSize
        Type = boxType
        HeaderSize = if boxSize > int64(UInt32.MaxValue) { 16u } else { 8u }
    }

    prop FilePosition int64

    prop TotalBoxSize int64 {
        get;
        init;
    }

    prop Type string
    prop HeaderSize uint32
    prop Version int32

    func ChangeAtomName(newAtomName string) {
        if String.IsNullOrEmpty(newAtomName) || Encoding.UTF8.GetByteCount(newAtomName) != 4 {
            throw ArgumentException("${nameof(newAtomName)} must be exactly 4 UTF-8 bytes long")
        }
        Type = newAtomName
    }

    func ToString() string {
        return Type
    }
}
