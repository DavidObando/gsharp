// <copyright file="TextChange.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Text

import System

/// A replacement of one span of a (cref:SourceText) with new text (ADR-0227 D1).
/// An empty span is an insertion. An empty new text is a deletion.
class TextChange {
    /// Initializes a new instance of the (cref:TextChange) class.
    /// @param span The span to replace, in positions of the original text.
    /// @param newText The text that replaces the span.
    init(span TextSpan, newText string) {
        if span.Start < 0 || span.Length < 0 {
            throw ArgumentOutOfRangeException(nameof(span))
        }
        ArgumentNullException.ThrowIfNull(newText)
        Span = span
        NewText = newText
    }

    /// Gets the span to replace, in positions of the original text.
    prop Span TextSpan {
        get;
    }

    /// Gets the text that replaces the span.
    prop NewText string {
        get;
    }

    /// Returns the change in a readable form.
    /// @returns The span and the new text.
    override func ToString() string -> "$Span -> \"$NewText\""
}
