// <copyright file="ByteStringEncoding.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Values

import System

/// Selects how UTF-16 input handles unpaired surrogate code units.
enum Utf16Encoding {
    /// Reject the first unpaired surrogate.
    Strict,
    /// Encode each unpaired code unit as U+FFFD.
    ReplaceUnpairedCodeUnit
}

/// Selects how UTF-8 input handles malformed byte sequences.
enum Utf8Decoding {
    /// Reject the first malformed sequence.
    Strict,
    /// Replace each invalid byte with U+FFFD, advancing exactly one byte.
    ReplaceInvalidByte
}

/// Identifies the encoding and offset unit of a failed text conversion.
enum ByteStringInputKind {
    /// UTF-8 input, with offsets measured in bytes.
    Utf8,
    /// UTF-16 input, with offsets measured in code units.
    Utf16
}

/// Reports the first malformed input in an eager strict text conversion.
sealed class ByteStringEncodingException : Exception {
    internal init(inputKind ByteStringInputKind, offset int32) : base(
        "Invalid " + inputKind.ToString() + " input at offset " + offset.ToString() + "."
    ) {
        InputKind = inputKind
        Offset = offset
    }

    /// Gets the input encoding and offset unit.
    prop InputKind ByteStringInputKind {
        get;
    }

    /// Gets the zero-based first-failure offset relative to the input value.
    prop Offset int32 {
        get;
    }
}
