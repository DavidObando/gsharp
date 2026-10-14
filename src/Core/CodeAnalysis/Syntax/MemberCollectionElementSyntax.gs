// <copyright file="MemberCollectionElementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// An explicit receiver member initializer, `.Member: value`, in an
/// ordered collection initializer (ADR-0180).
class MemberCollectionElementSyntax : CollectionElementSyntax {
    /// Initializes a new instance of the (cref:MemberCollectionElementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param dotToken The explicit receiver marker.
    /// @param initializer The member name, colon, and value.
    init(syntaxTree SyntaxTree, dotToken SyntaxToken, initializer FieldInitializerSyntax) : base(syntaxTree) {
        DotToken = dotToken
        Initializer = initializer
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.MemberCollectionElement

    /// Gets the explicit receiver marker.
    prop DotToken SyntaxToken {
        get;
    }

    /// Gets the member initializer.
    prop Initializer FieldInitializerSyntax {
        get;
    }
}
