package Oahu.Decrypt.Mpeg4

import System
import System.IO

open class TrackedReadStream(baseStream Stream, baseStreamLength int64) : Stream {
    private var readPosition int64 = 0
    prop CanRead bool -> this.baseStream.CanRead
    prop CanSeek bool -> this.baseStream.CanSeek
    prop Length int64 -> baseStreamLength
    prop CanWrite bool -> this.baseStream.CanWrite

    prop Position int64 {
        get -> if CanSeek { this.baseStream.Position } else { readPosition }
        set {
            if !CanSeek {
                throw NotSupportedException()
            }
            readPosition = value
            this.baseStream.Position = readPosition
        }
    }

    func Flush() {
        throw NotSupportedException()
    }

    func Read(buffer []uint8, offset int32, count int32) int32 {
        this.baseStream.ReadExactly(buffer, offset, count)
        readPosition += int64(count)
        return count
    }

    func Seek(offset int64, origin SeekOrigin) int64 {
        return if CanSeek { this.baseStream.Seek(offset, origin) } else { throw NotSupportedException()
            default(int64) }
    }

    func SetLength(value int64) -> this.baseStream.SetLength(value)
    func Write(buffer []uint8, offset int32, count int32) -> this.baseStream.Write(buffer, offset, count)

    protected func Dispose(disposing bool) {
        if disposing {
            this.baseStream.Dispose()
        }
        base.Dispose(disposing)
    }
}
