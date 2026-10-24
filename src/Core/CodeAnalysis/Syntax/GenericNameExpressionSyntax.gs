// <copyright file="GenericNameExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Issue #1323: a constructed-generic *type* reference used in expression
/// position, e.g. the `Box[int32?]` receiver in
/// `Box[int32?].Make(5)`. The parser emits this node (rather than an
/// (cref:IndexExpressionSyntax)) when a bracketed type-argument list is
/// unambiguously a type — it carries one or more (cref:TypeClauseSyntax)
/// arguments that need not be expressible as ordinary index expressions (a
/// nullable `T?`, an array/slice `[]T`, or a nested generic
/// `List[T]`) — and is followed by a member access (`.Member`). The
/// binder resolves it to the closed construction so static-member access binds
/// against the constructed type.
partial class GenericNameExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:GenericNameExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param identifier The generic type name.
    /// @param typeArgumentList The bracketed type-argument list.
    init(syntaxTree SyntaxTree, identifier SyntaxToken, typeArgumentList TypeArgumentListSyntax) : base(syntaxTree) {
        Identifier = identifier
        TypeArgumentList = typeArgumentList
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.GenericNameExpression

    /// Gets the contextual readonly modifier for a native slice receiver.
    prop ReadOnlySliceModifier SyntaxToken? {
        get;
        internal set;
    }

    /// Gets the contextual readonly modifier of a CLR span alias receiver.
    prop ReadOnlySpanModifier SyntaxToken? {
        get;
        internal set;
    }

    /// Gets the contextual readonly modifier of a managed-reference type receiver.
    prop ReadOnlyManagedModifier SyntaxToken? {
        get;
        internal set;
    }

    /// Gets the generic type name.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the bracketed type-argument list.
    prop TypeArgumentList TypeArgumentListSyntax {
        get;
    }
}
