// <copyright file="CollectionElementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Issue #479 / ADR-0117: the base class for a single element of a
/// (cref:CollectionInitializerExpressionSyntax). The concrete
/// shapes are (cref:ExpressionCollectionElementSyntax) (a bare element
/// `expr`, including `...source`), (cref:KeyedCollectionElementSyntax) (a key/value entry
/// `key: value`), and (cref:IndexedCollectionElementSyntax) (an
/// indexed entry `[key] = value`), and (cref:MemberCollectionElementSyntax)
/// (an explicit receiver member `.Member: value`, ADR-0180).
abstract class CollectionElementSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:CollectionElementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    internal init(syntaxTree SyntaxTree) : base(syntaxTree) { }
}
