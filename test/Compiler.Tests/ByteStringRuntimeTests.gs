// <copyright file="ByteStringRuntimeTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import Gsharp.Values
import System
import System.Collections.Generic
import System.Reflection
import System.Runtime.CompilerServices
import System.Threading.Tasks
import Xunit

class ByteStringRuntimeTests {
    @Fact
    func MutableInputsAndExportsNeverAliasContents() {
        let source = []uint8{0, 255, 195, 40}
        let input = Slice[uint8].FromArray(source)
        let value = ByteString.CopyFrom(input.AsReadOnly())
        let spanCopy = ByteString.CopyFrom(cast[ReadOnlySpan[uint8]](source.AsSpan()))
        source[0] = 90
        input[1] = 91
        let exported = value.ToArray()
        let slice = value.ToSlice()
        exported[2] = 92
        slice[3] = 93
        Assert.Equal([]uint8{0, 255, 195, 40}, value.ToArray())
        Assert.Equal([]uint8{0, 255, 195, 40}, spanCopy.ToArray())
        Assert.Equal([]uint8{0, 255, 195, 40}, value.ToSlice().ToArray())
    }

    @Fact
    func EqualityHashAndUnsignedOrderingDependOnlyOnContents() {
        let value = ByteString.FromLiteral("00FF")
        let other = ByteString.FromLiteral("7000FF80").Subslice(1, 3)
        Assert.True(value == other)
        Assert.False(value != other)
        Assert.True(value.Equals(cast[object](other)))
        Assert.False(value.Equals(cast[object]("00FF")))
        Assert.False(value.Equals(default(object?)))
        Assert.Equal(value.GetHashCode(), other.GetHashCode())
        Assert.Equal(0, value.CompareTo(other))
        Assert.True(ByteString.FromLiteral("FF") > ByteString.FromLiteral("7F"))
        Assert.True(value < value + ByteString.FromLiteral("00"))
        Assert.True(value <= other)
        Assert.True(value >= other)
        let dictionary = Dictionary[ByteString, int32]()
        dictionary.Add(value, 1)
        Assert.Equal(1, dictionary[other])
        Assert.Equal(default(ByteString), ByteString.FromLiteral(""))
        Assert.Equal(default(ByteString).GetHashCode(), value.Subslice(1, 1).GetHashCode())
        let absent ByteString? = nil
        let present ByteString? = ByteString.Empty
        Assert.NotEqual(absent, present)
        Assert.NotNull(default(ByteString).ToArray())
        Assert.True(default(ByteString).ToSlice().IsEmpty)
        let type = TypeSymbol.FromClrTypeWithoutNullability(typeof(ByteString), NullabilityFreeReason.ResolvedTypeName)
        Assert.Equal("bytestring", SymbolDisplay.ToTypeDisplayString(type))
        Assert.Equal("bytestring", SymbolDisplay.ToTypeDisplayString(typeof(ByteString)))
    }

    @Fact
    func SearchAndCopyUseLogicalByteLengthsAndDoNotPartiallyWrite() {
        let value = ByteString.FromLiteral("4100FF4100FF").Subslice(1, 5)
        Assert.True(value.StartsWith(ByteString.FromLiteral("00FF")))
        Assert.True(value.EndsWith(ByteString.FromLiteral("4100")))
        Assert.Equal(1, value.IndexOf(ByteString.FromLiteral("FF41")))
        Assert.Equal(-1, value.IndexOf(ByteString.FromLiteral("FF00")))
        Assert.Equal(0, value.IndexOf(ByteString.Empty))
        Assert.True(value.StartsWith(ByteString.Empty))
        Assert.True(value.EndsWith(ByteString.Empty))
        let destination = []uint8{7, 7, 7, 7, 7, 7}
        let writable = Slice[uint8].FromArray(destination)
        Assert.Throws[ArgumentException](
            func () {
                value.CopyTo(writable.Subslice(0, 3))
            }
        )
        Assert.Equal([]uint8{7, 7, 7, 7, 7, 7}, destination)
        value.CopyTo(writable)
        Assert.Equal([]uint8{0, 255, 65, 0, 7, 7}, destination)
        Assert.Equal(uint8(0), value[Index(1, true)])
        Assert.Equal([]uint8{255, 65}, value[Range(Index(1), Index(1, true))].ToArray())
        Assert.Throws[ArgumentOutOfRangeException](
            func () object? {
                return value[-1]
            }
        )
        Assert.Throws[ArgumentOutOfRangeException](
            func () object? {
                return value[Index(0, true)]
            }
        )
        Assert.Throws[ArgumentOutOfRangeException](
            func () object? {
                return value.Subslice(3, 2)
            }
        )
        Assert.Throws[ArgumentOutOfRangeException](
            func () object? {
                return value.Subslice(0, 5)
            }
        )
    }

    @Fact
    func DetachCompactsAndEmptySubviewsReleaseTheirOwner() {
        let value = ByteString.FromLiteral("01020304")
        let part = value.Subslice(1, 3)
        Assert.Same(Owner(value), Owner(part))
        let detached = part.Detach()
        Assert.Equal(part, detached)
        Assert.NotSame(Owner(part), Owner(detached))
        Assert.Equal(2, cast[[]uint8](Owner(detached)!!).Length)
        Assert.NotSame(Owner(value), Owner(value.Detach()))
        Assert.Null(Owner(part.Subslice(1, 1)))
        let (retained, released) = DetachedOwner()
        GC.Collect()
        GC.WaitForPendingFinalizers()
        GC.Collect()
        Assert.False(released.IsAlive)
        Assert.Equal([]uint8{2, 3}, retained.ToArray())
        GC.KeepAlive(retained)
    }

    @Fact
    func EnumerationYieldsByteValuesAndDiagnosticsNeverDecodeText() {
        let value = ByteString.FromLiteral("0022FF5C41")
        let enumerated = List[uint8]()
        for item in value {
            enumerated.Add(item)
        }
        Assert.Equal([]uint8{0, 34, 255, 92, 65}, enumerated)
        Assert.Equal("b\"\\x00\\\"\\xFF\\\\A\"", value.ToString())
        Assert.True(ByteString.FromLiteral(String('F', 200)).ToString().Length < 150)
    }

    @Fact
    func WarmLiteralFactoriesAndValueIterationAllocateNoByteBuffers() {
        let key = "0041FF"
        ByteString.FromLiteral(key)
        var checksum = 0
        let before = GC.GetAllocatedBytesForCurrentThread()
        for var i = 0; i < 10_000; i++ {
            for value in ByteString.FromLiteral(key) {
                checksum += value
            }
        }
        let allocated = GC.GetAllocatedBytesForCurrentThread() - before
        Assert.Equal(3_200_000, checksum)
        Assert.Equal(0L, allocated)
    }

    @Fact
    func ConcurrentLiteralPublicationHasOneImmutableOwner() {
        let key = string.Concat("CA", Guid.NewGuid().ToString("N"))
        let values = [64]ByteString
        Parallel.For(
            0,
            values.Length,
            (i int32) -> {
                values[i] = ByteString.FromLiteral(key)
            }
        )
        let expected = Convert.FromHexString(key)
        let owner = Owner(values[0])
        Assert.NotNull(owner)
        Assert.All(
            values,
            (value ByteString) -> {
                Assert.Equal(expected, value.ToArray())
                Assert.Same(owner, Owner(value))
            }
        )
    }

    shared {
        private func Owner(value ByteString) object? -> typeof(ByteString).GetField(
            "owner",
            BindingFlags.Instance | BindingFlags.NonPublic
        )!!.GetValue(value)

        @MethodImpl(MethodImplOptions.NoInlining)
        private func DetachedOwner()(Value ByteString, Owner WeakReference) {
            let input = []uint8{1, 2, 3, 4}
            let value = ByteString.CopyFrom(Slice[uint8].FromArray(input).AsReadOnly())
            return (value.Subslice(1, 3).Detach(), WeakReference(Owner(value)!!))
        }
    }
}
