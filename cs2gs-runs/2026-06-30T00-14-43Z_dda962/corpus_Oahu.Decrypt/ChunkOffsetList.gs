package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.Buffers.Binary
import System.Collections
import System.Collections.Generic
import System.IO
import System.Linq
import System.Runtime.InteropServices
import Oahu.Decrypt.Mpeg4.Util

class ChunkOffsetList : ICollection[int64] {
    private let chunkOffsets32 List[uint32]
    private var chunkOffsets64 List[int64]?

    init() {
        chunkOffsets32 = List[uint32]()
    }

    private init(capacity int32) {
        chunkOffsets32 = List[uint32](capacity)
    }

    prop Count int32 -> chunkOffsets32.Count + (chunkOffsets64?.Count ?? 0)
    prop IsReadOnly bool -> false

    func Clear() {
        chunkOffsets32.Clear()
        chunkOffsets64?.Clear()
        chunkOffsets64 = nil
    }

    func Sort() {
        if chunkOffsets64 != nil {
            chunkOffsets64!!.Sort()
            let index = ChunkOffsetList.FindLast32bit(CollectionsMarshal.AsSpan(chunkOffsets64!!))
            if index >= 0 {
                let countToMove = index + 1
                let toMove = [countToMove]uint32
                for var i = 0; i < countToMove; i++ {
                    toMove[i] = uint32(chunkOffsets64!![i])
                }
                chunkOffsets32.AddRange(toMove)
                chunkOffsets64!!.RemoveRange(0, countToMove)
                if chunkOffsets64!!.Count == 0 {
                    chunkOffsets64 = nil
                }
            }
        }
        chunkOffsets32.Sort()
    }

    func GetOffsetAtIndex(index int32) int64 {
        var index = index
        if index < chunkOffsets32.Count {
            return chunkOffsets32[index]
        } else if chunkOffsets64 != nil {
            index -= chunkOffsets32.Count
            if index < chunkOffsets64!!.Count {
                return chunkOffsets64!![index]
            }
        }
        throw IndexOutOfRangeException("Index $index is out of range for chunk offsets.")
    }

    func SetOffsetAtIndex(index int32, value int64) {
        var index = index
        if index < chunkOffsets32.Count {
            if value > int64(UInt32.MaxValue) {
                let toMove = chunkOffsets32.Count - index
                let longs = [toMove]int64
                longs[0] = value
                for var i = 1; i < toMove; i++ {
                    longs[i] = chunkOffsets32[index + i]
                }
                CollectionsMarshal.SetCount(chunkOffsets32, index)
                chunkOffsets64 ??= List[int64](longs.Length)
                chunkOffsets64!!.InsertRange(0, longs)
            } else {
                chunkOffsets32[index] = uint32(value)
            }
            return
        } else if chunkOffsets64 != nil {
            index -= chunkOffsets32.Count
            if index < chunkOffsets64!!.Count {
                chunkOffsets64!![index] = value
                return
            }
        }
        throw IndexOutOfRangeException("Index $index is out of range for chunk offsets.")
    }

    func Write32(file Stream) {
        if chunkOffsets64 != nil && chunkOffsets64!!.Count > 0 {
            throw InvalidOperationException("Cannot write 32-bit chunk offsets when 64-bit offsets are present.")
        }
        let span = CollectionsMarshal.AsSpan(chunkOffsets32)
        if BitConverter.IsLittleEndian {
            BinaryPrimitives.ReverseEndianness(span, span)
        }
        file.Write(MemoryMarshal.AsBytes(span))
        if BitConverter.IsLittleEndian {
            BinaryPrimitives.ReverseEndianness(span, span)
        }
    }

    func Write64(file Stream) {
        for offset32 in chunkOffsets32 {
            file.WriteInt64BE(offset32)
        }
        let span64 = CollectionsMarshal.AsSpan(chunkOffsets64)
        if BitConverter.IsLittleEndian {
            BinaryPrimitives.ReverseEndianness(span64, span64)
        }
        file.Write(MemoryMarshal.AsBytes(span64))
        if BitConverter.IsLittleEndian {
            BinaryPrimitives.ReverseEndianness(span64, span64)
        }
    }

    func IndexOf(item int64) int32 {
        if item <= int64(UInt32.MaxValue) {
            let index32 = chunkOffsets32.IndexOf(uint32(item))
            if index32 >= 0 {
                return index32
            }
        } else if chunkOffsets64 != nil {
            let index64 = chunkOffsets64!!.IndexOf(item)
            if index64 >= 0 {
                return chunkOffsets32.Count + index64
            }
        }
        return -1
    }

    func RemoveAt(index int32) {
        var index = index
        if index < chunkOffsets32.Count {
            chunkOffsets32.RemoveAt(index)
            return
        } else if chunkOffsets64 != nil {
            index -= chunkOffsets32.Count
            if index < chunkOffsets64!!.Count {
                chunkOffsets64!!.RemoveAt(index)
                return
            }
        }
        throw IndexOutOfRangeException()
    }

    func Add(offset int64) {
        if offset > int64(UInt32.MaxValue) {
            chunkOffsets64 ??= List[int64]()
            chunkOffsets64!!.Add(offset)
        } else {
            chunkOffsets32.Add(uint32(offset))
        }
    }

    func Contains(item int64) bool -> IndexOf(item) >= 0

    func Remove(item int64) bool {
        let index = IndexOf(item)
        if index >= 0 {
            RemoveAt(index)
            return true
        }
        return false
    }

    func GetEnumerator() IEnumerator[int64] -> chunkOffsets32.ConvertAll((i uint32) -> int64(i)).Concat(chunkOffsets64 ?? List[int64]()).GetEnumerator()

    func CopyTo(array []int64, arrayIndex int32) {
        var arrayIndex = arrayIndex
        {
            var i = 0
            while i < chunkOffsets32.Count {
                array[arrayIndex] = chunkOffsets32[i]
                i++
                arrayIndex++
            }
        }
        if chunkOffsets64 != nil {
            {
                var i = 0
                while i < chunkOffsets64!!.Count {
                    array[arrayIndex] = chunkOffsets64!![i]
                    i++
                    arrayIndex++
                }
            }
        }
    }

    private func GetEnumerator() IEnumerator -> GetEnumerator()

    shared {
        func Read32(file Stream, entryCount uint32) ChunkOffsetList {
            let list = ChunkOffsetList(int32(entryCount))
            CollectionsMarshal.SetCount(list.chunkOffsets32, int32(entryCount))
            let span = CollectionsMarshal.AsSpan(list.chunkOffsets32)
            file.ReadExactly(MemoryMarshal.AsBytes(span))
            if BitConverter.IsLittleEndian {
                BinaryPrimitives.ReverseEndianness(span, span)
            }
            var lastChunkOffset int64 = 0
            for var i = 0; i < list.chunkOffsets32.Count; i++ {
                var chunkOffset int64 = list.chunkOffsets32[i]
                if chunkOffset < lastChunkOffset && lastChunkOffset - chunkOffset > int64(UInt32.MaxValue / uint32(2)) {
                    if list.chunkOffsets64 == nil {
                        let count = list.chunkOffsets32.Count - i
                        list.chunkOffsets64 = List[int64](count)
                    }
                    chunkOffset += 1L << 32
                    list.chunkOffsets32.RemoveAt(i)
                    i--
                    list.chunkOffsets64!!.Add(chunkOffset)
                }
                lastChunkOffset = chunkOffset
            }
            list.chunkOffsets32.Sort()
            list.chunkOffsets64?.Sort()
            return list
        }

        func Read64(file Stream, entryCount uint32) ChunkOffsetList {
            unsafe {
                let pLongs = Marshal.AllocHGlobal(8 * IntPtr(entryCount))
                try {
                    let longsSpan = Span[int64](pLongs.ToPointer(), int32(entryCount))
                    file.ReadExactly(MemoryMarshal.AsBytes(longsSpan))
                    if BitConverter.IsLittleEndian {
                        BinaryPrimitives.ReverseEndianness(longsSpan, longsSpan)
                    }
                    longsSpan.Sort()
                    let count32Bit = ChunkOffsetList.FindLast32bit(longsSpan) + 1
                    let list = ChunkOffsetList(count32Bit)
                    CollectionsMarshal.SetCount(list.chunkOffsets32, count32Bit)
                    let span = CollectionsMarshal.AsSpan(list.chunkOffsets32)
                    for var i = 0; i < count32Bit; i++ {
                        span[i] = uint32(longsSpan[i])
                    }
                    let remainder = longsSpan.Slice(count32Bit)
                    list.chunkOffsets64 = List[int64](remainder.Length)
                    CollectionsMarshal.SetCount(list.chunkOffsets64!!, remainder.Length)
                    let span64 = CollectionsMarshal.AsSpan(list.chunkOffsets64!!)
                    remainder.CopyTo(span64)
                    return list
                } finally {
                    Marshal.FreeHGlobal(pLongs)
                }
            }
        }

        private func FindLast32bit(longsSpan ReadOnlySpan[int64]) int32 {
            var l = 0
            var r = longsSpan.Length - 1
            while l <= r {
                let mid = l + (r - l) / 2
                let midValue = longsSpan[mid]
                if midValue > int64(UInt32.MaxValue) {
                    r = mid - 1
                } else if midValue == int64(UInt32.MaxValue) || mid >= r || longsSpan[mid + 1] >= int64(UInt32.MaxValue) {
                    return mid
                } else {
                    l = mid + 1
                }
            }
            return -1
        }
    }
}
