package Oahu.Decrypt.Mpeg4.Util

import System
import System.Buffers
import System.Buffers.Binary
import System.IO
import System.Threading
import System.Threading.Tasks
import Oahu.Decrypt.Mpeg4.Boxes

func (stream Stream) WriteHeader(header BoxHeader, renderSize int64) {
    if header.Version == 1 || renderSize > int64(UInt32.MaxValue) {
        stream.WriteUInt32BE(1)
        stream.WriteType(header.Type)
        stream.WriteInt64BE(renderSize)
    } else {
        stream.WriteUInt32BE(uint32(renderSize))
        stream.WriteType(header.Type)
    }
}

async func (inputStream Stream) SeekToOffsetAsync(chunkOffset int64, token CancellationToken) {
    if inputStream.Position == chunkOffset {
        return
    } else if inputStream.CanSeek {
        inputStream.Position = chunkOffset
    } else if inputStream.Position < chunkOffset {
        const bufferSize = 8 * 1024
        var toRead = Int32.Min(bufferSize, int32((chunkOffset - inputStream.Position)))
        using let memoryBuff = MemoryPool[uint8].Shared.Rent(toRead)
        while toRead > 0 {
            await inputStream.ReadExactlyAsync(memoryBuff!!.Memory.Slice(0, toRead), token)
            toRead = Int32.Min(bufferSize, int32((chunkOffset - inputStream.Position)))
        }
    } else {
        throw NotSupportedException("Input stream position 0x${inputStream.Position:X8} is past the chunk offset 0x${chunkOffset:X8} and is not seekable.")
    }
}

func (inputStream Stream) SeekToOffset(chunkOffset int64) {
    if inputStream.Position == chunkOffset {
        return
    } else if inputStream.CanSeek {
        inputStream.Position = chunkOffset
    } else if inputStream.Position < chunkOffset {
        const bufferSize = 8 * 1024
        var toRead = Int32.Min(bufferSize, int32((chunkOffset - inputStream.Position)))
        using let memoryBuff = MemoryPool[uint8].Shared.Rent(toRead)
        let spanBuff = memoryBuff!!.Memory.Span
        while toRead > 0 {
            inputStream.ReadExactly(spanBuff.Slice(0, toRead))
            toRead = Int32.Min(bufferSize, int32((chunkOffset - inputStream.Position)))
        }
    } else {
        throw NotSupportedException("Input stream position 0x${inputStream.Position:X8} is past the chunk offset 0x${chunkOffset:X8} and is not seekable.")
    }
}

async func (inputStream Stream) ReadNextChunkAsync(chunkOffset int64, chunkBuffer Memory[uint8], token CancellationToken) {
    await inputStream.SeekToOffsetAsync(chunkOffset, token)
    if await inputStream.ReadAsync(chunkBuffer, token) != chunkBuffer.Length {
        throw EndOfStreamException("Stream ended at position ${inputStream.Position} before all ${chunkBuffer.Length} bytes were read.")
    }
}

func (stream Stream) WriteType(type_ string) {
    if type_?.Length != 4 {
        throw ArgumentException("Type must be 4 chars long.")
    }
    stream.Write([]uint8{uint8(type_[0]), uint8(type_[1]), uint8(type_[2]), uint8(type_[3])})
}

func (stream Stream) WriteInt16BE(value int16) {
    let word = stackalloc [2]uint8
    BinaryPrimitives.WriteInt16BigEndian(word, value)
    stream.Write(word)
}

func (stream Stream) WriteUInt16BE(value uint16) {
    let word = stackalloc [2]uint8
    BinaryPrimitives.WriteUInt16BigEndian(word, value)
    stream.Write(word)
}

func (stream Stream) WriteInt32BE(value int32) {
    let dword = stackalloc [4]uint8
    BinaryPrimitives.WriteInt32BigEndian(dword, value)
    stream.Write(dword)
}

func (stream Stream) WriteUInt32BE(value uint32) {
    let dword = stackalloc [4]uint8
    BinaryPrimitives.WriteUInt32BigEndian(dword, value)
    stream.Write(dword)
}

func (stream Stream) WriteInt64BE(value int64) {
    let qword = stackalloc [8]uint8
    BinaryPrimitives.WriteInt64BigEndian(qword, value)
    stream.Write(qword)
}

func (stream Stream) WriteUInt64BE(value uint64) {
    let qword = stackalloc [8]uint8
    BinaryPrimitives.WriteUInt64BigEndian(qword, value)
    stream.Write(qword)
}

func (stream Stream) ReadInt16BE() int16 {
    let word = stackalloc [2]uint8
    stream.ReadExactly(word)
    return BinaryPrimitives.ReadInt16BigEndian(word)
}

func (stream Stream) ReadUInt16BE() uint16 {
    let word = stackalloc [2]uint8
    stream.ReadExactly(word)
    return BinaryPrimitives.ReadUInt16BigEndian(word)
}

func (stream Stream) ReadInt32BE() int32 {
    let dword = stackalloc [4]uint8
    stream.ReadExactly(dword)
    return BinaryPrimitives.ReadInt32BigEndian(dword)
}

func (stream Stream) ReadUInt32BE() uint32 {
    let dword = stackalloc [4]uint8
    stream.ReadExactly(dword)
    return BinaryPrimitives.ReadUInt32BigEndian(dword)
}

func (stream Stream) ReadInt64BE() int64 {
    let qword = stackalloc [8]uint8
    stream.ReadExactly(qword)
    return BinaryPrimitives.ReadInt64BigEndian(qword)
}

func (stream Stream) ReadUInt64BE() uint64 {
    let qword = stackalloc [8]uint8
    stream.ReadExactly(qword)
    return BinaryPrimitives.ReadUInt64BigEndian(qword)
}

func (stream Stream) ReadType() string {
    let dword = stackalloc [4]uint8
    stream.ReadExactly(dword)
    return string([]char{char(dword[0]), char(dword[1]), char(dword[2]), char(dword[3])})
}

func (stream Stream) ReadBlock(length int32) []uint8 {
    if length < 0 {
        throw ArgumentException("Length must be non-negative", nameof(length))
    } else if length == 0 {
        return []uint8{}
    } else {
        let buffer = [length]uint8
        stream.ReadExactly(buffer)
        return buffer
    }
}
