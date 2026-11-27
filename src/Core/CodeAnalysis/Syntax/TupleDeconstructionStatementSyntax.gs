// <copyright file="TupleDeconstructionStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// A tuple deconstruction declaration `let (a, b, ...) = expr` or
/// `var (a, b, ...) = expr`. Each identifier becomes a local bound to the
/// corresponding tuple element of the right-hand-side initializer.
partial class TupleDeconstructionStatementSyntax : StatementSyntax {
    private var declarationAnnotations ImmutableArray[AnnotationSyntax] = ImmutableArray[AnnotationSyntax].Empty

    /// Gets the annotations attached to this declaration.
    prop Annotations ImmutableArray[AnnotationSyntax] -> declarationAnnotations

    internal func WithAnnotations(annotations ImmutableArray[AnnotationSyntax]) {
        declarationAnnotations = annotations
        InvalidateCachedSpan()
    }

    /// Initializes a new instance of the (cref:TupleDeconstructionStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param keyword The `let` or `var` keyword.
    /// @param openParenToken The opening `(`.
    /// @param identifiers The comma-separated identifier list.
    /// @param closeParenToken The closing `)`.
    /// @param equalsToken The `=` token.
    /// @param initializer The tuple-typed initializer expression.
    init(
        syntaxTree SyntaxTree,
        keyword SyntaxToken,
        openParenToken SyntaxToken,
        identifiers SeparatedSyntaxList[SyntaxToken],
        closeParenToken SyntaxToken,
        equalsToken SyntaxToken,
        initializer ExpressionSyntax
    ) : base(syntaxTree) {
        Keyword = keyword
        OpenParenToken = openParenToken
        Identifiers = identifiers
        CloseParenToken = closeParenToken
        EqualsToken = equalsToken
        Initializer = initializer
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.TupleDeconstructionStatement

    /// Gets the `let` or `var` keyword token.
    prop Keyword SyntaxToken {
        get;
    }

    /// Gets the opening parenthesis token.
    prop OpenParenToken SyntaxToken {
        get;
    }

    /// Gets the deconstruction target identifiers.
    prop Identifiers SeparatedSyntaxList[SyntaxToken] {
        get;
    }

    /// Gets the closing parenthesis token.
    prop CloseParenToken SyntaxToken {
        get;
    }

    /// Gets the equals token.
    prop EqualsToken SyntaxToken {
        get;
    }

    /// Gets the right-hand-side tuple expression.
    prop Initializer ExpressionSyntax {
        get;
    }
}
