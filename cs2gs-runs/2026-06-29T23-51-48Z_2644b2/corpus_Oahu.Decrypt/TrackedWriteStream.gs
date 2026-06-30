package Oahu.Decrypt.Mpeg4

import System
import System.IO

open class TrackedWriteStream(baseStream Stream, writePosition int64 = 0) : Stream {
    prop CanRead bool -> false
    prop CanSeek bool -> this.baseStream.CanSeek
    prop Length int64 -> writePosition
    prop CanWrite bool -> this.baseStream.CanWrite

    prop Position int64 {
        get -> if CanSeek { this.baseStream.Position } else { writePosition }
        set {
            if !CanSeek {
                throw NotSupportedException()
            }
            this.baseStream.Position = value
        }
    }

    func Flush() -> this.baseStream.Flush()

    func Read(buffer []uint8, offset int32, count int32) int32 {
        throw NotSupportedException()
    }

    func Seek(offset int64, origin SeekOrigin) int64 {
        return if CanSeek { this.baseStream.Seek(offset, origin) } else { throw NotSupportedException()
            default(int64) }
    }

    func SetLength(value int64) {
        throw NotSupportedException()
    }

    func Write(buffer []uint8, offset int32, count int32) {
        this.baseStream.Write(buffer, offset, count)
        writePosition += int64(count)
    }

    protected func Dispose(disposing bool) {
        if disposing {
            this.baseStream.Dispose()
        }
        base.Dispose(disposing)
    }
}
