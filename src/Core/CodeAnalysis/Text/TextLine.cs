// <copyright file="TextLine.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Text
{
    /// <summary>
    /// Representation of a text line in a document.
    /// </summary>
    public sealed class TextLine
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="TextLine"/> class.
        /// </summary>
        /// <param name="text">The source text.</param>
        /// <param name="start">The start index in the document.</param>
        /// <param name="length">The length of the line in the document.</param>
        /// <param name="lengthIncludingLineBreak">The length of the line in the document including line break characters.</param>
        public TextLine(SourceText text, int start, int length, int lengthIncludingLineBreak)
        {
            Text = text;
            Start = start;
            Length = length;
            LengthIncludingLineBreak = lengthIncludingLineBreak;
        }

        /// <summary>
        /// Gets the source text.
        /// </summary>
        public SourceText Text { get; }

        /// <summary>
        /// Gets the index in the document at which this line starts.
        /// </summary>
        public int Start { get; }

        /// <summary>
        /// Gets the length of the line in the document.
        /// </summary>
        public int Length { get; }

        /// <summary>
        /// Gets the index in the document at which this line ends not including line break characters.
        /// </summary>
        public int End => Start + Length;

        /// <summary>
        /// Gets the length of the line in the document including line break characters.
        /// </summary>
        public int LengthIncludingLineBreak { get; }

        /// <summary>
        /// Gets the text span of this line in the document.
        /// </summary>
        public TextSpan Span => new TextSpan(Start, Length);

        /// <summary>
        /// Gets the text span of this line in the document, including line break characters.
        /// </summary>
        public TextSpan SpanIncludingLineBreak => new TextSpan(Start, LengthIncludingLineBreak);

        /// <summary>
        /// String representation of this text line.
        /// </summary>
        /// <returns>A string with the contents of this text line, not including line break characters.</returns>
        public override string ToString() => Text.ToString(Span);
    }
}
