// <copyright file="AnnotationTargetSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents the optional use-site target qualifier on an annotation
/// (ADR-0047 §4): the `field`, `param`, `return`, `type`,
/// `method`, `property`, `event`, `module`,
/// `assembly`, or `genericparam` identifier that immediately
/// follows `@` and is terminated by `:`.
///
/// The kind keywords are *contextual* — they are ordinary identifiers
/// everywhere else in the language; the lexer does not promote them.
partial class AnnotationTargetSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:AnnotationTargetSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param kindIdentifier The contextual target-kind identifier (e.g. `field`).
    /// @param colonToken The trailing `:` token.
    init(syntaxTree SyntaxTree, kindIdentifier SyntaxToken, colonToken SyntaxToken) : base(syntaxTree) {
        KindIdentifier = kindIdentifier
        ColonToken = colonToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.AnnotationTarget

    /// Gets the contextual target-kind identifier (its (cref:SyntaxToken.Text) is the canonical kind name).
    prop KindIdentifier SyntaxToken {
        get;
    }

    /// Gets the trailing `:` token.
    prop ColonToken SyntaxToken {
        get;
    }
}
