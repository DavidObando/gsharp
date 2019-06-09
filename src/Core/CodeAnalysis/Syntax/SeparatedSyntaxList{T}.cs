// <copyright file="SeparatedSyntaxList{T}.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    using System.Collections;
    using System.Collections.Generic;
    using System.Collections.Immutable;

    /// <summary>
    /// Separated syntax list that includes separators in order to represent
    /// expression lists with full fidelity. Useful for IDE-like experiences.
    /// </summary>
    /// <typeparam name="T">The type of syntax nodes to enumerate.</typeparam>
    public class SeparatedSyntaxList<T> : SeparatedSyntaxList, IEnumerable<T>
        where T : SyntaxNode
    {
        private readonly ImmutableArray<SyntaxNode> nodesAndSeparators;

        /// <summary>
        /// Initializes a new instance of the <see cref="SeparatedSyntaxList{T}"/> class.
        /// </summary>
        /// <param name="nodesAndSeparators">A list of syntax nodes including separators.</param>
        public SeparatedSyntaxList(ImmutableArray<SyntaxNode> nodesAndSeparators)
        {
            this.nodesAndSeparators = nodesAndSeparators;
        }

        /// <summary>
        /// Gets the count of nodes in the list, not including separators.
        /// </summary>
        public int Count => (nodesAndSeparators.Length + 1) / 2;

        /// <summary>
        /// Gets the item at the specified index, not including separators.
        /// The value of index has to be between 0 and <see cref="Count"/>.
        /// </summary>
        /// <param name="index">The index of the item to fetch.</param>
        /// <returns>The syntax node at the specified location.</returns>
        public T this[int index] => (T)nodesAndSeparators[index * 2];

        /// <summary>
        /// Gets the separator syntax token at the specified index.
        /// The value of index has to be between 0 and <see cref="Count"/> - 1.
        /// </summary>
        /// <param name="index">The index of the separator.</param>
        /// <returns>The syntax token representing the separator.</returns>
        public SyntaxToken GetSeparator(int index)
        {
            if (index == Count - 1)
            {
                return null;
            }

            return (SyntaxToken)nodesAndSeparators[(index * 2) + 1];
        }

        /// <summary>
        /// Gets the full list o syntax nodes, including separators.
        /// </summary>
        /// <returns>An immutable list with the entire set of syntax nodes.</returns>
        public override ImmutableArray<SyntaxNode> GetWithSeparators() => nodesAndSeparators;

        /// <summary>
        /// Gets an enumerator for the list of nodes not including the separators.
        /// </summary>
        /// <returns>An <see cref="IEnumerator{T}"/> of syntax nodes.</returns>
        public IEnumerator<T> GetEnumerator()
        {
            for (var i = 0; i < Count; i++)
            {
                yield return this[i];
            }
        }

        /// <summary>
        /// Gets an enumerator for the list of nodes not including the separators.
        /// </summary>
        /// <returns>An <see cref="IEnumerator"/> of syntax nodes.</returns>
        IEnumerator IEnumerable.GetEnumerator()
        {
            return GetEnumerator();
        }
    }
}
