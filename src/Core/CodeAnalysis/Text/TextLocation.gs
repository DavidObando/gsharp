// <copyright file="TextLocation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Text

import System

/// An abstraction of a source text and a text span within the source text.
struct TextLocation : IComparable[TextLocation] {
    /// Initializes a new instance of the (cref:TextLocation) struct.
    /// @param text The source text.
    /// @param span The text span within the source text.
    init(text SourceText, span TextSpan) {
        Text = text
        Span = span
    }

    /// Gets the source text. Null for a location-less entry
    /// (`default(TextLocation)`, e.g. a synthesized or assembly-level
    /// diagnostic with no source location).
    prop Text SourceText? {
        get;
    }

    /// Gets the text span within the source text.
    prop Span TextSpan {
        get;
    }

    // The four positional accessors below use `Text!`: line/character
    // coordinates are only defined for located entries (constructed via the
    // constructor, whose `text` parameter is non-nullable). On a
    // location-less `default(TextLocation)` they throw, exactly as before
    // nullable annotations; callers that may hold a location-less entry must
    // check `Text` first (see TextWriterExtensions.WriteDiagnostics).
    /// Gets the zero-based start line in the source text as indicated by the text span.
    /// Only defined for located entries (non-null (cref:Text)).
    prop StartLine int32 -> Text!!.GetLineIndex(Span.Start)

    /// Gets the zero-based start line character as indicated by the text span.
    /// Only defined for located entries (non-null (cref:Text)).
    prop StartCharacter int32 -> Span.Start - Text!!.Lines[StartLine].Start

    /// Gets the zero-based end line in the source text as indicated by the text span.
    /// Only defined for located entries (non-null (cref:Text)).
    prop EndLine int32 -> Text!!.GetLineIndex(Span.End)

    /// Gets the zero-based end line character as indicated by the text span.
    /// Only defined for located entries (non-null (cref:Text)).
    prop EndCharacter int32 -> Span.End - Text!!.Lines[EndLine].Start

    /// Gets the zero-based start and end line and character in one pass: two
    /// line lookups, where reading the four properties separately costs six.
    /// Only defined for located entries (non-null (cref:Text)).
    /// @returns The start line, start character, end line and end character.
    internal func GetLineRange()(StartLine int32, StartCharacter int32, EndLine int32, EndCharacter int32) {
        let source = Text!!
        let startLine = source.GetLineIndex(Span.Start)
        let endLine = source.GetLineIndex(Span.End)
        return (startLine, Span.Start - source.Lines[startLine].Start, endLine, Span.End - source.Lines[endLine].Start)
    }

    /// Gets the file name. Null for a location-less entry; empty for source
    /// texts created without a file name.
    prop FileName string? -> Text?.FileName

    /// Compares two text locations, useful for sorting sets of text locations.
    /// @param other The text location to compare to.
    /// @returns A value indicating the relation of the first text span to the second one.
    func CompareTo(other TextLocation) int32 {
        // A `default(TextLocation)` (e.g. a synthesized or assembly-level
        // diagnostic with no source location) has a null `Text`, and even a
        // present `Text` may expose a null `FileName`. Guard both so the
        // comparer is total and never throws: location-less entries sort
        // consistently ahead of located ones. A non-total comparer here makes
        // `OrderBy`/`Array.Sort` throw `InvalidOperationException: Failed to
        // compare two elements in the array`, which the compiler surfaces as
        // GS9998 and which masks every other diagnostic in the batch.
        let thisFile string? = Text?.FileName
        let otherFile string? = other.Text?.FileName
        var cmp = string.CompareOrdinal(thisFile, otherFile)
        if cmp == 0 {
            cmp = Span.CompareTo(other.Span)
        }
        return cmp
    }
}
