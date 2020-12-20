// <copyright file="TextSpan.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Text
{
    using System;

    /// <summary>
    /// An abstract representation of a span with a start and an end index.
    /// </summary>
    public struct TextSpan : IComparable<TextSpan>
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="TextSpan"/> struct.
        /// </summary>
        /// <param name="start">Start index.</param>
        /// <param name="length">Length.</param>
        public TextSpan(int start, int length)
        {
            Start = start;
            Length = length;
        }

        /// <summary>
        /// Gets the start index of the span.
        /// </summary>
        public int Start { get; }

        /// <summary>
        /// Gets the length of the span.
        /// </summary>
        public int Length { get; }

        /// <summary>
        /// Gets the end of the span.
        /// </summary>
        public int End => Start + Length;

        /// <summary>
        /// Creates a new span given the specified start and end boundaries.
        /// </summary>
        /// <param name="start">The start boundary.</param>
        /// <param name="end">The end boundary.</param>
        /// <returns>A materialized span.</returns>
        public static TextSpan FromBounds(int start, int end)
        {
            var length = end - start;
            return new TextSpan(start, length);
        }

        /// <summary>
        /// Compares two text spans, useful for sorting sets of text spans.
        /// </summary>
        /// <param name="other">The text span to compare to.</param>
        /// <returns>A value indicating the relation of the first text span to the second one.</returns>
        public int CompareTo(TextSpan other)
        {
            int cmp = Start - other.Start;
            if (cmp == 0)
            {
                cmp = Length - other.Length;
            }

            return cmp;
        }

        /// <summary>
        /// A string representation of the span.
        /// </summary>
        /// <returns>A string containing the start and end index of the span.</returns>
        public override string ToString() => $"{Start}..{End}";
    }
}
