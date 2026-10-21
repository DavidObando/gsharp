// <copyright file="ByteString.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Values

import System
import System.Buffers
import System.Collections
import System.Collections.Generic
import System.ComponentModel
import System.Diagnostics
import System.Globalization
import System.Runtime.CompilerServices
import System.Text

/// An immutable sequence of arbitrary bytes with content equality.
@DebuggerDisplay("{Length} bytes: {ToString(),nq}")
struct ByteString : IEquatable[ByteString], IComparable[ByteString], IEnumerable[uint8] {
    private let owner[]?uint8
    private let offset int32

    private init(owner[]uint8, offset int32, length int32) {
        this.owner = owner
        this.offset = offset
        Length = length
    }

    /// Gets the number of bytes.
    prop Length int32 {
        get;
    }

    /// Gets whether this value is empty.
    prop IsEmpty bool -> Length == 0

    private prop Owner[]uint8 -> owner ?? Array.Empty[uint8]()

    /// Gets one byte by value.
    prop this[index int32]uint8 {
        get {
            if uint32(index) >= uint32(Length) {
                throw ArgumentOutOfRangeException("index")
            }
            return Owner[offset + index]
        }
    }

    /// Gets one byte using a from-end index.
    prop this[index Index]uint8 -> this[index.GetOffset(Length)]

    /// Gets an immutable shared substring.
    prop this[value Range]ByteString -> Subslice(value)

    /// Returns an immutable view with exclusive endpoints.
    func Subslice(lo int32, hi int32) ByteString {
        if uint32(lo) > uint32(Length) {
            throw ArgumentOutOfRangeException("lo")
        }
        if hi < lo || hi > Length {
            throw ArgumentOutOfRangeException("hi")
        }
        return if hi == lo {
            default(ByteString)
        } else {
            ByteString(Owner, offset + lo, hi - lo)
        }
    }

    /// Returns an immutable view using logical-length-relative bounds.
    func Subslice(value Range) ByteString -> Subslice(value.Start.GetOffset(Length), value.End.GetOffset(Length))

    /// Concatenates bytes without decoding text.
    func Concat(other ByteString) ByteString {
        if IsEmpty {
            return other
        }
        if other.IsEmpty {
            return this
        }
        if other.Length > int32.MaxValue - Length {
            throw OverflowException("The byte-string length exceeds Int32.MaxValue.")
        }
        let length = Length + other.Length
        let result = [length]uint8
        Array.Copy(Owner, offset, result, 0, Length)
        Array.Copy(other.Owner, other.offset, result, Length, other.Length)
        return ByteString(result, 0, length)
    }

    /// Compares byte contents independently of backing storage.
    func Equals(other ByteString) bool {
        if Length != other.Length {
            return false
        }
        if Object.ReferenceEquals(owner, other.owner) && offset == other.offset {
            return true
        }
        for var i = 0; i < Length; i++ {
            if this[i] != other[i] {
                return false
            }
        }
        return true
    }

    override func Equals(value object?) bool -> value is ByteString other && Equals(other)

    /// Computes a process-local content hash.
    override func GetHashCode() int32 {
        var hash = HashCode()
        for var i = 0; i < Length; i++ {
            hash.Add(this[i])
        }
        return hash.ToHashCode()
    }

    /// Compares unsigned bytes lexicographically.
    func CompareTo(other ByteString) int32 {
        let count = Math.Min(Length, other.Length)
        for var i = 0; i < count; i++ {
            let difference = int32(this[i]) - int32(other[i])
            if difference != 0 {
                return difference
            }
        }
        return Length.CompareTo(other.Length)
    }

    /// Tests a bytewise prefix.
    func StartsWith(prefix ByteString) bool -> prefix.Length <= Length && Subslice(0, prefix.Length).Equals(prefix)

    /// Tests a bytewise suffix.
    func EndsWith(suffix ByteString) bool -> suffix.Length <= Length && Subslice(Length - suffix.Length, Length).Equals(
        suffix
    )

    /// Finds a byte sequence, returning its byte offset or -1.
    func IndexOf(needle ByteString) int32 -> Owner.AsSpan(offset, Length).IndexOf(
        needle.Owner.AsSpan(needle.offset, needle.Length)
    )

    /// Copies all bytes, rejecting a short destination before writing.
    func CopyTo(destination Slice[uint8]) {
        if destination.Length < Length {
            throw ArgumentException("The destination is shorter than the byte string.", "destination")
        }
        Owner.AsSpan(offset, Length).CopyTo(destination.AsSpan())
    }

    /// Returns independent writable storage containing the logical bytes.
    func ToArray()[]uint8 {
        if IsEmpty {
            return Array.Empty[uint8]()
        }
        let result = [Length]uint8
        Array.Copy(Owner, offset, result, 0, Length)
        return result
    }

    /// Returns independent writable native-slice storage.
    func ToSlice() Slice[uint8] -> Slice[uint8].FromArray(ToArray())

    /// Copies into compact storage without retaining the original owner.
    func Detach() ByteString -> if IsEmpty {
        default(ByteString)
    } else {
        ByteString(ToArray(), 0, Length)
    }

    /// Decodes UTF-8 with an explicit policy, without normalization or BOM stripping.
    /// Strict failures throw (cref:ByteStringEncodingException) at the malformed sequence's first byte.
    /// Offsets are relative to this value. No partial string is returned.
    /// Invalid policies throw (cref:ArgumentOutOfRangeException), including on empty input.
    /// @param policy The required malformed-input policy.
    /// @returns The decoded CLR string, preserving embedded NUL and BOM characters.
    func DecodeUtf8(policy Utf8Decoding) string {
        var scalars = DecodeUtf8Scalars(policy).GetEnumerator()
        let result = StringBuilder()
        let buffer = [2]char
        while scalars.MoveNext() {
            let written = Rune(scalars.Current.Value).EncodeToUtf16(buffer.AsSpan())
            result.Append(buffer, 0, written)
        }
        return result.ToString()
    }

    /// Lazily decodes scalars with byte offsets relative to this value.
    /// Strict failures throw (cref:ByteStringEncodingException) at MoveNext, after any valid prefix.
    /// Repeated MoveNext calls report the same failure without advancing.
    /// Invalid policies throw (cref:ArgumentOutOfRangeException) immediately, including on empty input.
    /// @param policy The required malformed-input policy.
    /// @returns A concrete value enumerable without buffer copies or per-scalar allocations.
    func DecodeUtf8Scalars(policy Utf8Decoding) Utf8Enumerable {
        if policy != Utf8Decoding.Strict && policy != Utf8Decoding.ReplaceInvalidByte {
            throw ArgumentOutOfRangeException("policy")
        }
        return Utf8Enumerable(this, policy)
    }

    /// Gets a value enumerator that yields bytes, not storage references.
    func GetEnumerator() Enumerator -> Enumerator(this)

    private func (IEnumerable[uint8]) GetEnumerator() IEnumerator[uint8] -> GetEnumerator()

    private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()

    /// Produces a bounded escaped-byte preview, not decoded text.
    override func ToString() string {
        let result = StringBuilder("b\"")
        let count = Math.Min(Length, 32)
        for var i = 0; i < count; i++ {
            let value = this[i]
            if value == 34 || value == 92 {
                result.Append('\\')
                result.Append(char(value))
            } else if value >= 32 && value <= 126 {
                result.Append(char(value))
            } else {
                result.Append("\\x")
                result.Append(value.ToString("X2", CultureInfo.InvariantCulture))
            }
        }
        if count != Length {
            result.Append("...")
        }
        result.Append('"')
        return result.ToString()
    }

    /// Enumerates immutable byte values.
    struct Enumerator : IEnumerator[uint8] {
        private let value ByteString
        private var index int32

        internal init(value ByteString) {
            this.value = value
            index = -1
        }

        /// Gets the current byte.
        prop Current uint8 -> value[index]

        private prop(IEnumerator) Current object -> Current

        /// Advances to the next byte.
        func MoveNext() bool {
            if index < value.Length {
                index++
            }
            return index < value.Length
        }

        /// Resets enumeration.
        func Reset() {
            index = -1
        }

        /// Releases no resources.
        func Dispose() { }
    }

    /// Enumerates UTF-8 scalars without decoding until MoveNext.
    struct Utf8Enumerable {
        private let value ByteString
        private let policy Utf8Decoding

        internal init(value ByteString, policy Utf8Decoding) {
            this.value = value
            this.policy = policy
        }

        /// Gets an independent value enumerator.
        func GetEnumerator() Enumerator -> Enumerator(value, policy)

        /// Enumerates scalar values within the byte string's logical bounds.
        struct Enumerator {
            private let value ByteString
            private let policy Utf8Decoding
            private var cursor int32
            private var current Utf8Item

            internal init(value ByteString, policy Utf8Decoding) {
                this.value = value
                this.policy = policy
                cursor = 0
                current = default(Utf8Item)
            }

            /// Gets the last successfully decoded scalar and its input byte range.
            prop Current Utf8Item -> current

            /// Advances one scalar, or one malformed byte under replacement.
            func MoveNext() bool {
                if cursor >= value.Length {
                    return false
                }
                let source = cast[ReadOnlySpan[uint8]](value.Owner.AsSpan(value.offset + cursor, value.Length - cursor))
                let status = Rune.DecodeFromUtf8(source, out var scalar, out var consumed)
                if status != OperationStatus.Done {
                    if policy == Utf8Decoding.Strict {
                        throw ByteStringEncodingException(ByteStringInputKind.Utf8, cursor)
                    }
                    // ADR-0204 replaces one byte, not the BCL's malformed-sequence grouping.
                    consumed = 1
                    scalar = Rune.ReplacementChar
                }
                current = Utf8Item(cursor, scalar.Value, consumed)
                cursor += consumed
                return true
            }
        }
    }

    private class LiteralStorage {
        let Value ByteString

        init(hex string) {
            let bytes = Convert.FromHexString(hex)
            Value = ByteString(bytes, 0, bytes.Length)
        }
    }

    shared {
        private let literals ConditionalWeakTable[string, LiteralStorage] =
        ConditionalWeakTable[string, LiteralStorage]()

        /// Gets the canonical empty value.
        prop Empty ByteString -> default(ByteString)

        /// Encodes CLR text as UTF-8 without normalization or BOM insertion.
        /// Strict failures throw (cref:ByteStringEncodingException) at the first unpaired UTF-16 code unit.
        /// No partial value is returned. Null CLR text throws (cref:ArgumentNullException).
        /// Invalid policies throw (cref:ArgumentOutOfRangeException), including on empty input.
        /// @param text The non-null CLR string to encode.
        /// @param policy The required unpaired-surrogate policy.
        /// @returns An immutable byte string, preserving embedded NUL and BOM characters.
        func EncodeUtf8(text string, policy Utf16Encoding) ByteString {
            ArgumentNullException.ThrowIfNull(text, "text")
            if policy != Utf16Encoding.Strict && policy != Utf16Encoding.ReplaceUnpairedCodeUnit {
                throw ArgumentOutOfRangeException("policy")
            }
            try {
                let bytes = UTF8Encoding(false, policy == Utf16Encoding.Strict).GetBytes(text)
                return if bytes.Length == 0 {
                    default(ByteString)
                } else {
                    ByteString(bytes, 0, bytes.Length)
                }
            } catch (ex EncoderFallbackException) {
                throw ByteStringEncodingException(ByteStringInputKind.Utf16, ex.Index)
            }
        }

        /// Copies a readonly view without adopting writable sibling storage.
        func CopyFrom(source ReadOnlySlice[uint8]) ByteString -> if source.IsEmpty {
            default(ByteString)
        } else {
            ByteString(source.ToArray(), 0, source.Length)
        }

        /// Copies borrowed bytes without retaining their source.
        func CopyFrom(source ReadOnlySpan[uint8]) ByteString -> if source.IsEmpty {
            default(ByteString)
        } else {
            ByteString(source.ToArray(), 0, source.Length)
        }

        /// Materializes compiler-owned literal bytes encoded as hexadecimal.
        @EditorBrowsable(EditorBrowsableState.Never)
        func FromLiteral(hex string) ByteString {
            ArgumentNullException.ThrowIfNull(hex)
            if hex.Length == 0 {
                return default(ByteString)
            }
            // Weak keys avoid retaining dynamically supplied compiler-service inputs.
            // The hit path creates neither a callback nor a byte buffer.
            if literals.TryGetValue(hex, out var existing) {
                return existing.Value
            }
            return literals.GetValue(hex, (text string) -> LiteralStorage(text)).Value
        }
    }
}

func (left ByteString) operator + (right ByteString) ByteString -> left.Concat(right)

func (left ByteString) operator == (right ByteString) bool -> left.Equals(right)

func (left ByteString) operator != (right ByteString) bool -> !left.Equals(right)

func (left ByteString) operator < (right ByteString) bool -> left.CompareTo(right) < 0

func (left ByteString) operator <= (right ByteString) bool -> left.CompareTo(right) <= 0

func (left ByteString) operator > (right ByteString) bool -> left.CompareTo(right) > 0

func (left ByteString) operator >= (right ByteString) bool -> left.CompareTo(right) >= 0
