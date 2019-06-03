// <copyright file="SourceText.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Text
{
    using System.Collections.Immutable;

    /// <summary>
    /// The source text of the compilation target. Represents the document.
    /// </summary>
    public sealed class SourceText
    {
        private readonly string text;

        private SourceText(string text)
        {
            this.text = text;
            Lines = ParseLines(this, text);
        }

        /// <summary>
        /// Gets the set of lines contained by this document.
        /// </summary>
        public ImmutableArray<TextLine> Lines { get; }

        /// <summary>
        /// Gets the length of the document.
        /// </summary>
        public int Length => text.Length;

        /// <summary>
        /// Gets the character at the specified document index.
        /// </summary>
        /// <param name="index">The document index.</param>
        /// <returns>The character at that index position in the document.</returns>
        public char this[int index] => text[index];

        /// <summary>
        /// Creates a source text document from a string.
        /// </summary>
        /// <param name="text">The string to wrap with a source text.</param>
        /// <returns>A hydrated source text instance.</returns>
        public static SourceText From(string text)
        {
            return new SourceText(text);
        }

        /// <summary>
        /// Gets the line index at the specified position in the document.
        /// </summary>
        /// <param name="position">The position in the document.</param>
        /// <returns>The line number for the specified index in the document.</returns>
        public int GetLineIndex(int position)
        {
            var lower = 0;
            var upper = Lines.Length - 1;

            while (lower <= upper)
            {
                var index = lower + ((upper - lower) / 2);
                var start = Lines[index].Start;

                if (position == start)
                {
                    return index;
                }

                if (start > position)
                {
                    upper = index - 1;
                }
                else
                {
                    lower = index + 1;
                }
            }

            return lower - 1;
        }

        /// <summary>
        /// Returns the document represented by this source text.
        /// </summary>
        /// <returns>The underlying document.</returns>
        public override string ToString() => text;

        /// <summary>
        /// Returns a subset of the document represented by this source text.
        /// </summary>
        /// <param name="start">Start index.</param>
        /// <param name="length">Length.</param>
        /// <returns>A subset of the underlying document.</returns>
        public string ToString(int start, int length) => text.Substring(start, length);

        /// <summary>
        /// Returns a subset of the document represented by this source text.
        /// </summary>
        /// <param name="span">The span to include.</param>
        /// <returns>A subset of the underlying document.</returns>
        public string ToString(TextSpan span) => ToString(span.Start, span.Length);

        private static ImmutableArray<TextLine> ParseLines(SourceText sourceText, string text)
        {
            var result = ImmutableArray.CreateBuilder<TextLine>();

            var position = 0;
            var lineStart = 0;

            while (position < text.Length)
            {
                var lineBreakWidth = GetLineBreakWidth(text, position);

                if (lineBreakWidth == 0)
                {
                    position++;
                }
                else
                {
                    AddLine(result, sourceText, position, lineStart, lineBreakWidth);

                    position += lineBreakWidth;
                    lineStart = position;
                }
            }

            if (position >= lineStart)
            {
                AddLine(result, sourceText, position, lineStart, 0);
            }

            return result.ToImmutable();
        }

        private static void AddLine(
            ImmutableArray<TextLine>.Builder result,
            SourceText sourceText,
            int position,
            int lineStart,
            int lineBreakWidth)
        {
            var lineLength = position - lineStart;
            var lineLengthIncludingLineBreak = lineLength + lineBreakWidth;
            var line = new TextLine(sourceText, lineStart, lineLength, lineLengthIncludingLineBreak);
            result.Add(line);
        }

        private static int GetLineBreakWidth(string text, int position)
        {
            var c = text[position];
            var l = position + 1 >= text.Length ? '\0' : text[position + 1];

            if (c == '\r' && l == '\n')
            {
                return 2;
            }

            if (c == '\r' || c == '\n')
            {
                return 1;
            }

            return 0;
        }
    }
}
