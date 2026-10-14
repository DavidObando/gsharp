// <copyright file="SeparatedSyntaxList{T}.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections
import System.Collections.Generic
import System.Collections.Immutable

/// Separated syntax list that includes separators in order to represent
/// expression lists with full fidelity. Useful for IDE-like experiences.
/// @typeparam T The type of syntax nodes to enumerate.
open class SeparatedSyntaxList[T SyntaxNode] : GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList, IEnumerable[T] {
    private let nodesAndSeparators ImmutableArray[SyntaxNode]

    /// Initializes a new instance of the (cref:SeparatedSyntaxList{T}) class.
    /// @param nodesAndSeparators A list of syntax nodes including separators.
    init(nodesAndSeparators ImmutableArray[SyntaxNode]) {
        this.nodesAndSeparators = nodesAndSeparators
    }

    /// Gets the count of nodes in the list, not including separators.
    prop Count int32 -> (nodesAndSeparators.Length + 1) / 2

    /// Gets the item at the specified index, not including separators.
    /// The value of index has to be between 0 and (cref:Count).
    /// @param index The index of the item to fetch.
    /// @returns The syntax node at the specified location.
    prop this[index int32]T -> cast[T](nodesAndSeparators[index * 2])

    /// Gets the separator syntax token at the specified index.
    /// The value of index has to be between 0 and (cref:Count) - 1.
    /// @param index The index of the separator.
    /// @returns The syntax token representing the separator.
    func GetSeparator(index int32) SyntaxToken? {
        if index == Count - 1 {
            return nil
        }
        return cast[SyntaxToken](nodesAndSeparators[(index * 2) + 1])
    }

    /// Gets the full list o syntax nodes, including separators.
    /// @returns An immutable list with the entire set of syntax nodes.
    open override func GetWithSeparators() ImmutableArray[SyntaxNode] -> nodesAndSeparators

    /// Gets an enumerator for the list of nodes not including the separators.
    /// @returns An (cref:IEnumerator{T}) of syntax nodes.
    func GetEnumerator() IEnumerator[T] {
        for var i = 0; i < Count; i++ {
            yield this[i]
        }
    }

    /// Gets an enumerator for the list of nodes not including the separators.
    /// @returns An (cref:IEnumerator) of syntax nodes.
    private func (IEnumerable) GetEnumerator() IEnumerator {
        return GetEnumerator()
    }
}
