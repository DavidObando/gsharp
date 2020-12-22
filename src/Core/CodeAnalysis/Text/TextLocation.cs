// <copyright file="TextLocation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Text
{
    using System;

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
        /// Gets the source text.
        /// </summary>
        public SourceText Text { get; }

        /// <summary>
        /// Gets the text span within the source text.
        /// </summary>
        public TextSpan Span { get; }

        /// <summary>
        /// Gets the zero-based start line in the source text as indicated by the text span.
        /// </summary>
        public int StartLine => Text.GetLineIndex(Span.Start);

        /// <summary>
        /// Gets the zero-based start line character as indicated by the text span.
        /// </summary>
        public int StartCharacter => Span.Start - Text.Lines[StartLine].Start;

        /// <summary>
        /// Gets the zero-based end line in the source text as indicated by the text span.
        /// </summary>
        public int EndLine => Text.GetLineIndex(Span.End);

        /// <summary>
        /// Gets the zero-based end line character as indicated by the text span.
        /// </summary>
        public int EndCharacter => Span.End - Text.Lines[EndLine].Start;

        /// <summary>
        /// Gets the file name.
        /// </summary>
        public string FileName => Text.FileName;

        /// <summary>
        /// Compares two text locations, useful for sorting sets of text locations.
        /// </summary>
        /// <param name="other">The text location to compare to.</param>
        /// <returns>A value indicating the relation of the first text span to the second one.</returns>
        public int CompareTo(TextLocation other)
        {
            int cmp = Text.FileName.CompareTo(other.Text.FileName);
            if (cmp == 0)
            {
                cmp = Span.CompareTo(other.Span);
            }

            return cmp;
        }
    }
}