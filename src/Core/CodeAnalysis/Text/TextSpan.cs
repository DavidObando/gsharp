// <copyright file="TextSpan.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Text
{
    /// <summary>
    /// An abstract representation of a span with a start and an end index.
    /// </summary>
    public struct TextSpan
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
        /// A string representation of the span.
        /// </summary>
        /// <returns>A string containing the start and end index of the span.</returns>
        public override string ToString() => $"{Start}..{End}";
    }
}
