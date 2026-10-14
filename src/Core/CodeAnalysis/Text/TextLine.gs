// <copyright file="TextLine.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Text

/// Representation of a text line in a document.
class TextLine {
    /// Initializes a new instance of the (cref:TextLine) class.
    /// @param text The source text.
    /// @param start The start index in the document.
    /// @param length The length of the line in the document.
    /// @param lengthIncludingLineBreak The length of the line in the document including line break
    /// characters.
    init(text SourceText, start int32, length int32, lengthIncludingLineBreak int32) {
        Text = text
        Start = start
        Length = length
        LengthIncludingLineBreak = lengthIncludingLineBreak
    }

    /// Gets the source text.
    prop Text SourceText {
        get;
    }

    /// Gets the index in the document at which this line starts.
    prop Start int32 {
        get;
    }

    /// Gets the length of the line in the document.
    prop Length int32 {
        get;
    }

    /// Gets the index in the document at which this line ends not including line break characters.
    prop End int32 -> Start + Length

    /// Gets the length of the line in the document including line break characters.
    prop LengthIncludingLineBreak int32 {
        get;
    }

    /// Gets the text span of this line in the document.
    prop Span TextSpan -> TextSpan(Start, Length)

    /// Gets the text span of this line in the document, including line break characters.
    prop SpanIncludingLineBreak TextSpan -> TextSpan(Start, LengthIncludingLineBreak)

    /// String representation of this text line.
    /// @returns A string with the contents of this text line, not including line break characters.
    override func ToString() string -> Text.ToString(Span)
}
