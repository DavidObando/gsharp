// <copyright file="TextSpan.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Text

import System

/// An abstract representation of a span with a start and an end index.
struct TextSpan : IComparable[TextSpan] {
    /// Initializes a new instance of the (cref:TextSpan) struct.
    /// @param start Start index.
    /// @param length Length.
    init(start int32, length int32) {
        Start = start
        Length = length
    }

    /// Gets the start index of the span.
    prop Start int32 {
        get;
    }

    /// Gets the length of the span.
    prop Length int32 {
        get;
    }

    /// Gets the end of the span.
    prop End int32 -> Start + Length

    /// Compares two text spans, useful for sorting sets of text spans.
    /// @param other The text span to compare to.
    /// @returns A value indicating the relation of the first text span to the second one.
    func CompareTo(other TextSpan) int32 {
        var cmp = Start - other.Start
        if cmp == 0 {
            cmp = Length - other.Length
        }
        return cmp
    }

    /// A string representation of the span.
    /// @returns A string containing the start and end index of the span.
    override func ToString() string -> "$Start..$End"

    shared {
        /// Creates a new span given the specified start and end boundaries.
        /// @param start The start boundary.
        /// @param end The end boundary.
        /// @returns A materialized span.
        func FromBounds(start int32, end int32) TextSpan {
            let length = end - start
            return TextSpan(start, length)
        }
    }
}
