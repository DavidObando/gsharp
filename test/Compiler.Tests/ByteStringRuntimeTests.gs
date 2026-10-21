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
    @Theory
    @InlineData(
        "007FC280DFBFE0A080ED9FBFEE8080EFBFBFF0908080F48FBFBF",
        "0:0:1,1:127:1,2:128:2,4:2047:2,6:2048:3,9:55295:3,12:57344:3,15:65535:3,18:65536:4,22:1114111:4"
    )
    @InlineData(
        "41C3A9E282ACF09F9880EFBBBF00EFBFBD65CC81",
        "0:65:1,1:233:2,3:8364:3,6:128512:4,10:65279:3,13:0:1,14:65533:3,17:101:1,18:769:2"
    )
    func Utf8ScalarsHaveExactValuesOffsetsAndWidths(hex string, expected string) {
        let value = ByteString.FromLiteral("FF" + hex + "FF").Subslice(1, 1 + hex.Length / 2)
        Assert.Equal(expected, ScalarItems(value.DecodeUtf8Scalars(Utf8Decoding.Strict)))
        Assert.Equal(expected, ScalarItems(value.DecodeUtf8Scalars(Utf8Decoding.ReplaceInvalidByte)))
    }

    @Theory
    @InlineData("80", "3:65533:1")
    @InlineData("BF", "3:65533:1")
    @InlineData("C0AF", "3:65533:1,4:65533:1")
    @InlineData("C1BF", "3:65533:1,4:65533:1")
    @InlineData("C2", "3:65533:1")
    @InlineData("C241", "3:65533:1,4:65:1")
    @InlineData("E080AF", "3:65533:1,4:65533:1,5:65533:1")
    @InlineData("EDA080", "3:65533:1,4:65533:1,5:65533:1")
    @InlineData("EDBFBF", "3:65533:1,4:65533:1,5:65533:1")
    @InlineData("E282", "3:65533:1,4:65533:1")
    @InlineData("E28241", "3:65533:1,4:65533:1,5:65:1")
    @InlineData("F0808080", "3:65533:1,4:65533:1,5:65533:1,6:65533:1")
    @InlineData("F4908080", "3:65533:1,4:65533:1,5:65533:1,6:65533:1")
    @InlineData("F5808080", "3:65533:1,4:65533:1,5:65533:1,6:65533:1")
    @InlineData("FF", "3:65533:1")
    @InlineData("F09F98", "3:65533:1,4:65533:1,5:65533:1")
    @InlineData("F0908041", "3:65533:1,4:65533:1,5:65533:1,6:65:1")
    @InlineData("E282EFBFBDF09F9880C2A2", "3:65533:1,4:65533:1,5:65533:3,8:128512:4,12:162:2")
    func Utf8ScalarsReplaceOneByteAndRepeatStrictFailure(hex string, expected string) {
        let value = ByteString.FromLiteral("FF41C2A2" + hex + "FF").Subslice(1, 4 + hex.Length / 2)
        Assert.Equal(
            "0:65:1,1:162:2," + expected,
            ScalarItems(value.DecodeUtf8Scalars(Utf8Decoding.ReplaceInvalidByte))
        )
        var iterator = value.DecodeUtf8Scalars(Utf8Decoding.Strict).GetEnumerator()
        Assert.True(iterator.MoveNext())
        Assert.Equal("0:65:1", ScalarItem(iterator.Current))
        Assert.True(iterator.MoveNext())
        Assert.Equal("1:162:2", ScalarItem(iterator.Current))
        for var retry = 0; retry < 3; retry++ {
            let error = Assert.Throws[ByteStringEncodingException](
                func () {
                    iterator.MoveNext()
                }
            )
            Assert.Equal(ByteStringInputKind.Utf8, error.InputKind)
            Assert.Equal(3, error.Offset)
        }
    }

    @Theory
    @InlineData(2, "0:65:1,1:65533:1")
    @InlineData(3, "0:65:1,1:65533:1,2:65533:1")
    func Utf8ScalarsNeverCompleteASequenceOutsideTheView(length int32, expected string) {
        let value = ByteString.FromLiteral("FF41E282ACFF").Subslice(1, 1 + length)
        Assert.Equal(expected, ScalarItems(value.DecodeUtf8Scalars(Utf8Decoding.ReplaceInvalidByte)))
        var iterator = value.DecodeUtf8Scalars(Utf8Decoding.Strict).GetEnumerator()
        Assert.True(iterator.MoveNext())
        Assert.Equal("0:65:1", ScalarItem(iterator.Current))
        for var retry = 0; retry < 2; retry++ {
            let error = Assert.Throws[ByteStringEncodingException](
                func () {
                    iterator.MoveNext()
                }
            )
            Assert.Equal(ByteStringInputKind.Utf8, error.InputKind)
            Assert.Equal(1, error.Offset)
        }
    }

    @Fact
    func Utf8ScalarsAreRepeatableWithIndependentValueCursorsAndEmptyDefaults() {
        Assert.False(default(ByteString.Utf8Enumerable).GetEnumerator().MoveNext())
        Assert.False(default(ByteString.Utf8Enumerable.Enumerator).MoveNext())
        for value in[]ByteString{default(ByteString), ByteString.Empty, ByteString.FromLiteral("FF").Subslice(1, 1)} {
            Assert.Equal("", ScalarItems(value.DecodeUtf8Scalars(Utf8Decoding.Strict)))
            Assert.Equal("", ScalarItems(value.DecodeUtf8Scalars(Utf8Decoding.ReplaceInvalidByte)))
        }
        let scalars = ByteString.FromLiteral("41C2A2").DecodeUtf8Scalars(Utf8Decoding.Strict)
        var first = scalars.GetEnumerator()
        Assert.True(first.MoveNext())
        var copy = first
        Assert.True(first.MoveNext())
        Assert.Equal("1:162:2", ScalarItem(first.Current))
        Assert.Equal("0:65:1", ScalarItem(copy.Current))
        Assert.False(first.MoveNext())
        Assert.False(first.MoveNext())
        Assert.True(copy.MoveNext())
        Assert.Equal("1:162:2", ScalarItem(copy.Current))
        Assert.False(copy.MoveNext())
        Assert.Equal("0:65:1,1:162:2", ScalarItems(scalars))
        Assert.Equal("0:65:1,1:162:2", ScalarItems(scalars))
    }

    @Fact
    func Utf8ScalarsRejectInvalidPoliciesAtTheFactoryEvenForEmptyInput() {
        for policy in[]int32{-1, 2, int32.MaxValue} {
            for value in[]ByteString{default(ByteString), ByteString.Empty, ByteString.FromLiteral("41FF")} {
                let error = Assert.Throws[ArgumentOutOfRangeException](
                    func () {
                        value.DecodeUtf8Scalars(cast[Utf8Decoding](policy))
                    }
                )
                Assert.Equal("policy", error.ParamName)
            }
        }
    }

    @Fact
    func Utf8ScalarsConcreteEnumerationAllocatesNoStorageAfterWarmup() {
        let value = ByteString.FromLiteral("FF" + String('4', 16_384) + "FF").Subslice(1, 8193)
        for var warmup = 0; warmup < 100; warmup++ {
            SumScalars(value, Utf8Decoding.Strict)
            SumScalars(value, Utf8Decoding.ReplaceInvalidByte)
        }
        let before = GC.GetAllocatedBytesForCurrentThread()
        var total = 0
        for var repeat = 0; repeat < 32; repeat++ {
            total += SumScalars(value, Utf8Decoding.Strict)
            total += SumScalars(value, Utf8Decoding.ReplaceInvalidByte)
        }
        let allocated = GC.GetAllocatedBytesForCurrentThread() - before
        Assert.Equal(8192 * 68 * 64, total)
        Assert.Equal(0L, allocated)
    }

    @Fact
    func Utf8DecodingAllocatesResultStorageRatherThanOneStringPerScalar() {
        let value = ByteString.FromLiteral(String('4', 16_384))
        let expected = String('D', 8192)
        value.DecodeUtf8(Utf8Decoding.Strict)
        value.DecodeUtf8(Utf8Decoding.ReplaceInvalidByte)
        let before = GC.GetAllocatedBytesForCurrentThread()
        let strict = value.DecodeUtf8(Utf8Decoding.Strict)
        let replacement = value.DecodeUtf8(Utf8Decoding.ReplaceInvalidByte)
        let allocated = GC.GetAllocatedBytesForCurrentThread() - before
        Assert.Equal(expected, strict)
        Assert.Equal(expected, replacement)
        // Allow builder chunks and returned strings, but not a temporary string per ASCII scalar.
        Assert.True(allocated < 98_304, "UTF-8 decoding allocated " + allocated.ToString() + " bytes.")
    }

    @Theory
    @InlineData("", "")
    @InlineData("007F", "\0\u007F")
    @InlineData("C280DFBF", "\u0080\u07FF")
    @InlineData("E0A080ED9FBFEE8080EFBFBF", "\u0800\uD7FF\uE000\uFFFF")
    @InlineData("F0908080F48FBFBF", "\uD800\uDC00\uDBFF\uDFFF")
    @InlineData("41C3A9E282ACF09F9880", "Aé€😀")
    @InlineData("EFBBBF0041EFBFBD", "\uFEFF\0A\uFFFD")
    @InlineData("65CC81", "e\u0301")
    func Utf8TextBoundariesPreserveExactScalars(hex string, text string) {
        let bytes = Convert.FromHexString(hex)
        let value = ByteString.FromLiteral("FF" + hex + "FF").Subslice(1, 1 + bytes.Length)
        Assert.Equal(text, value.DecodeUtf8(Utf8Decoding.Strict))
        Assert.Equal(text, value.DecodeUtf8(Utf8Decoding.ReplaceInvalidByte))
        Assert.Equal(bytes, ByteString.EncodeUtf8(text, Utf16Encoding.Strict).ToArray())
        Assert.Equal(bytes, ByteString.EncodeUtf8(text, Utf16Encoding.ReplaceUnpairedCodeUnit).ToArray())
    }

    @Theory
    @InlineData("80", "\uFFFD")
    @InlineData("BF", "\uFFFD")
    @InlineData("C0AF", "\uFFFD\uFFFD")
    @InlineData("C1BF", "\uFFFD\uFFFD")
    @InlineData("C2", "\uFFFD")
    @InlineData("C241", "\uFFFDA")
    @InlineData("E080AF", "\uFFFD\uFFFD\uFFFD")
    @InlineData("EDA080", "\uFFFD\uFFFD\uFFFD")
    @InlineData("EDBFBF", "\uFFFD\uFFFD\uFFFD")
    @InlineData("E282", "\uFFFD\uFFFD")
    @InlineData("E28241", "\uFFFD\uFFFDA")
    @InlineData("F0808080", "\uFFFD\uFFFD\uFFFD\uFFFD")
    @InlineData("F4908080", "\uFFFD\uFFFD\uFFFD\uFFFD")
    @InlineData("F5808080", "\uFFFD\uFFFD\uFFFD\uFFFD")
    @InlineData("FF", "\uFFFD")
    @InlineData("F09F98", "\uFFFD\uFFFD\uFFFD")
    @InlineData("F0908041", "\uFFFD\uFFFD\uFFFDA")
    @InlineData("E282EFBFBDF09F9880C2A2", "\uFFFD\uFFFD\uFFFD😀¢")
    func Utf8MalformedSequencesFailAtTheirStartAndReplaceOneByte(hex string, replacement string) {
        let prefix = "41C2A2"
        let value = ByteString.FromLiteral("FF" + prefix + hex + "FF").Subslice(1, 4 + hex.Length / 2)
        var result = "not published"
        let error = Assert.Throws[ByteStringEncodingException](
            func () {
                result = value.DecodeUtf8(Utf8Decoding.Strict)
            }
        )
        Assert.Equal(ByteStringInputKind.Utf8, error.InputKind)
        Assert.Equal(3, error.Offset)
        Assert.Equal("not published", result)
        Assert.Equal("A¢" + replacement, value.DecodeUtf8(Utf8Decoding.ReplaceInvalidByte))
        let atZero = ByteString.FromLiteral(hex)
        let zeroError = Assert.Throws[ByteStringEncodingException](
            func () object? {
                return atZero.DecodeUtf8(Utf8Decoding.Strict)
            }
        )
        Assert.Equal(0, zeroError.Offset)
    }

    @Theory
    @InlineData("D800", "EFBFBD", 0)
    @InlineData("DC00", "EFBFBD", 0)
    @InlineData("0041D800", "41EFBFBD", 1)
    @InlineData("D800D800DC00", "EFBFBDF0908080", 0)
    @InlineData("D800DC00DC00", "F0908080EFBFBD", 2)
    @InlineData("D8000041DC00", "EFBFBD41EFBFBD", 0)
    @InlineData("DC00D800", "EFBFBDEFBFBD", 0)
    @InlineData("0041DBFFDFFFD800D8000042", "41F48FBFBFEFBFBDEFBFBD42", 3)
    func Utf16UnpairedCodeUnitsHaveExactOffsetsAndIndividualReplacements(units string, hex string, offset int32) {
        let chars = [units.Length / 4]char
        for var i = 0; i < chars.Length; i++ {
            chars[i] = char(Convert.ToInt32(units.Substring(i * 4, 4), 16))
        }
        let text = String(chars)
        var result = ByteString.FromLiteral("FF")
        let error = Assert.Throws[ByteStringEncodingException](
            func () {
                result = ByteString.EncodeUtf8(text, Utf16Encoding.Strict)
            }
        )
        Assert.Equal(ByteStringInputKind.Utf16, error.InputKind)
        Assert.Equal(offset, error.Offset)
        Assert.Equal([]uint8{255}, result.ToArray())
        Assert.Equal(
            Convert.FromHexString(hex),
            ByteString.EncodeUtf8(text, Utf16Encoding.ReplaceUnpairedCodeUnit).ToArray()
        )
    }

    @Fact
    func Utf8EmptyDefaultsPoliciesAndOwnershipRemainExplicit() {
        for value in[]ByteString{default(ByteString), ByteString.Empty, ByteString.FromLiteral("FF").Subslice(1, 1)} {
            Assert.Equal("", value.DecodeUtf8(Utf8Decoding.Strict))
            Assert.Equal("", value.DecodeUtf8(Utf8Decoding.ReplaceInvalidByte))
        }
        Assert.Null(Owner(ByteString.EncodeUtf8("", Utf16Encoding.Strict)))
        Assert.Null(Owner(ByteString.EncodeUtf8("", Utf16Encoding.ReplaceUnpairedCodeUnit)))
        for policy in[]int32{-1, 2, int32.MaxValue} {
            for value in[]ByteString{default(ByteString), ByteString.FromLiteral("41")} {
                let error = Assert.Throws[ArgumentOutOfRangeException](
                    func () object? {
                        return value.DecodeUtf8(cast[Utf8Decoding](policy))
                    }
                )
                Assert.Equal("policy", error.ParamName)
            }
            for text in[]string{"", "A"} {
                let error = Assert.Throws[ArgumentOutOfRangeException](
                    func () object? {
                        return ByteString.EncodeUtf8(text, cast[Utf16Encoding](policy))
                    }
                )
                Assert.Equal("policy", error.ParamName)
            }
        }
        let encoded = ByteString.EncodeUtf8("A\0é", Utf16Encoding.Strict)
        let exported = encoded.ToArray()
        exported[0] = 0
        let slice = encoded.ToSlice()
        slice[1] = 255
        Assert.Equal([]uint8{65, 0, 195, 169}, encoded.ToArray())
        Assert.Equal("A\0é", encoded.DecodeUtf8(Utf8Decoding.Strict))
    }

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
        private func ScalarItem(item Utf8Item) string ->
        item.ByteOffset.ToString() + ":" + item.Value.ToString() + ":" + item.ByteLength.ToString()

        private func ScalarItems(items ByteString.Utf8Enumerable) string {
            let result = List[string]()
            for item in items {
                result.Add(ScalarItem(item))
            }
            return String.Join(",", result)
        }

        private func SumScalars(value ByteString, policy Utf8Decoding) int32 {
            var result = 0
            for item in value.DecodeUtf8Scalars(policy) {
                result += item.Value
            }
            return result
        }

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
