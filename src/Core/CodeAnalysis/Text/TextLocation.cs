// <copyright file="TextLocation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;

namespace GSharp.Core.CodeAnalysis.Text;

/// <summary>
/// An abstraction of a source text and a text span within the source text.
/// </summary>
public struct TextLocation : IComparable<TextLocation>
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TextLocation"/> struct.
    /// </summary>
    /// <param name="text">The source text.</param>
    /// <param name="span">The text span within the source text.</param>
    public TextLocation(SourceText text, TextSpan span)
    {
        Text = text;
        Span = span;
    }

    /// <summary>
    /// Gets the source text. Null for a location-less entry
    /// (<c>default(TextLocation)</c>, e.g. a synthesized or assembly-level
    /// diagnostic with no source location).
    /// </summary>
    public SourceText? Text { get; }

    /// <summary>
    /// Gets the text span within the source text.
    /// </summary>
    public TextSpan Span { get; }

    // The four positional accessors below use `Text!`: line/character
    // coordinates are only defined for located entries (constructed via the
    // constructor, whose `text` parameter is non-nullable). On a
    // location-less `default(TextLocation)` they throw, exactly as before
    // nullable annotations; callers that may hold a location-less entry must
    // check `Text` first (see TextWriterExtensions.WriteDiagnostics).

    /// <summary>
    /// Gets the zero-based start line in the source text as indicated by the text span.
    /// Only defined for located entries (non-null <see cref="Text"/>).
    /// </summary>
    public int StartLine => Text!.GetLineIndex(Span.Start);

    /// <summary>
    /// Gets the zero-based start line character as indicated by the text span.
    /// Only defined for located entries (non-null <see cref="Text"/>).
    /// </summary>
    public int StartCharacter => Span.Start - Text!.Lines[StartLine].Start;

    /// <summary>
    /// Gets the zero-based end line in the source text as indicated by the text span.
    /// Only defined for located entries (non-null <see cref="Text"/>).
    /// </summary>
    public int EndLine => Text!.GetLineIndex(Span.End);

    /// <summary>
    /// Gets the zero-based end line character as indicated by the text span.
    /// Only defined for located entries (non-null <see cref="Text"/>).
    /// </summary>
    public int EndCharacter => Span.End - Text!.Lines[EndLine].Start;

    /// <summary>
    /// Gets the file name. Null for a location-less entry; empty for source
    /// texts created without a file name.
    /// </summary>
    public string? FileName => Text?.FileName;

    /// <summary>
    /// Compares two text locations, useful for sorting sets of text locations.
    /// </summary>
    /// <param name="other">The text location to compare to.</param>
    /// <returns>A value indicating the relation of the first text span to the second one.</returns>
    public int CompareTo(TextLocation other)
    {
        // A `default(TextLocation)` (e.g. a synthesized or assembly-level
        // diagnostic with no source location) has a null `Text`, and even a
        // present `Text` may expose a null `FileName`. Guard both so the
        // comparer is total and never throws: location-less entries sort
        // consistently ahead of located ones. A non-total comparer here makes
        // `OrderBy`/`Array.Sort` throw `InvalidOperationException: Failed to
        // compare two elements in the array`, which the compiler surfaces as
        // GS9998 and which masks every other diagnostic in the batch.
        string? thisFile = Text?.FileName;
        string? otherFile = other.Text?.FileName;

        int cmp = string.CompareOrdinal(thisFile, otherFile);
        if (cmp == 0)
        {
            cmp = Span.CompareTo(other.Span);
        }

        return cmp;
    }
}
