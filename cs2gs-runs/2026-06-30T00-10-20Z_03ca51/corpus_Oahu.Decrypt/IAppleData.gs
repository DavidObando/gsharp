package Oahu.Decrypt.Mpeg4

import System
import System.Buffers.Binary

interface IAppleData[TData IAppleData[TData]] {
    func Write(destination Span[uint8]);

    shared {
        prop SizeInBytes int32 {
            get;
        }

        func Create(source ReadOnlySpan[uint8]) TData;
    }
}

open data class TrackNumber(Track uint16, TotalTracks uint16) : IAppleData[TrackNumber] {
    func operator implicit(tn (int32, int32)) TrackNumber {
        ArgumentOutOfRangeException.ThrowIfNegative(tn.Item1, nameof(tn.Item1))
        ArgumentOutOfRangeException.ThrowIfNegative(tn.Item2, nameof(tn.Item2))
        ArgumentOutOfRangeException.ThrowIfGreaterThan(tn.Item1, int32(UInt16.MaxValue), nameof(tn.Item1))
        ArgumentOutOfRangeException.ThrowIfGreaterThan(tn.Item2, int32(UInt16.MaxValue), nameof(tn.Item2))
        return TrackNumber(uint16(tn.Item1), uint16(tn.Item2))
    }

    func Write(destination Span[uint8]) {
        ArgumentOutOfRangeException.ThrowIfLessThan(destination.Length, TrackNumber.SizeInBytes, nameof(destination))
        BinaryPrimitives.WriteUInt16BigEndian(destination.Slice(2, 4 - 2), Track)
        BinaryPrimitives.WriteUInt16BigEndian(destination.Slice(4, 6 - 4), TotalTracks)
    }

    shared {
        prop SizeInBytes int32 -> 8

        func Create(source ReadOnlySpan[uint8]) TrackNumber {
            ArgumentOutOfRangeException.ThrowIfLessThan(source.Length, TrackNumber.SizeInBytes, nameof(source))
            return TrackNumber(BinaryPrimitives.ReadUInt16BigEndian(source.Slice(2, 4 - 2)), BinaryPrimitives.ReadUInt16BigEndian(source.Slice(4, 6 - 4)))
        }
    }
}

open data class DiskNumber(Disk uint16, TotalDisks uint16) : IAppleData[DiskNumber] {
    func operator implicit(tn (int32, int32)) DiskNumber {
        ArgumentOutOfRangeException.ThrowIfNegative(tn.Item1, nameof(tn.Item1))
        ArgumentOutOfRangeException.ThrowIfNegative(tn.Item2, nameof(tn.Item2))
        ArgumentOutOfRangeException.ThrowIfGreaterThan(tn.Item1, int32(UInt16.MaxValue), nameof(tn.Item1))
        ArgumentOutOfRangeException.ThrowIfGreaterThan(tn.Item2, int32(UInt16.MaxValue), nameof(tn.Item2))
        return DiskNumber(uint16(tn.Item1), uint16(tn.Item2))
    }

    func Write(destination Span[uint8]) {
        ArgumentOutOfRangeException.ThrowIfLessThan(destination.Length, DiskNumber.SizeInBytes, nameof(destination))
        BinaryPrimitives.WriteUInt16BigEndian(destination.Slice(2, 4 - 2), Disk)
        BinaryPrimitives.WriteUInt16BigEndian(destination.Slice(4, 6 - 4), TotalDisks)
    }

    shared {
        prop SizeInBytes int32 -> 6

        func Create(source ReadOnlySpan[uint8]) DiskNumber {
            ArgumentOutOfRangeException.ThrowIfLessThan(source.Length, DiskNumber.SizeInBytes, nameof(source))
            return DiskNumber(BinaryPrimitives.ReadUInt16BigEndian(source.Slice(2, 4 - 2)), BinaryPrimitives.ReadUInt16BigEndian(source.Slice(4, 6 - 4)))
        }
    }
}
