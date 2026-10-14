// <copyright file="IndexExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents an index expression `target[index]` or the
/// ADR-0073 / issue #710 null-conditional form `target?[index]`.
class IndexExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:IndexExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param target The expression being indexed.
    /// @param openBracketToken The opening bracket token. Either
    /// (cref:SyntaxKind.OpenSquareBracketToken) for plain indexing
    /// or (cref:SyntaxKind.QuestionOpenBracketToken) for the
    /// null-conditional form.
    /// @param index The index expression.
    /// @param closeBracketToken The closing bracket token.
    convenience init(
        syntaxTree SyntaxTree,
        target ExpressionSyntax,
        openBracketToken SyntaxToken,
        index ExpressionSyntax,
        closeBracketToken SyntaxToken
    ) {
        init(
            syntaxTree,
            target,
            openBracketToken,
            SeparatedSyntaxList[ExpressionSyntax](ImmutableArray.Create[SyntaxNode](index)),
            closeBracketToken
        )
    }

    /// Initializes a new instance of the (cref:IndexExpressionSyntax) class.
    /// @param syntaxTree Parent syntax tree.
    /// @param target Indexed target.
    /// @param openBracketToken Opening bracket.
    /// @param indices Index expressions.
    /// @param closeBracketToken Closing bracket.
    init(
        syntaxTree SyntaxTree,
        target ExpressionSyntax,
        openBracketToken SyntaxToken,
        indices SeparatedSyntaxList[ExpressionSyntax],
        closeBracketToken SyntaxToken
    ) : base(syntaxTree) {
        Target = target
        OpenBracketToken = openBracketToken
        Indices = indices
        CloseBracketToken = closeBracketToken
        IsNullConditional = openBracketToken.Kind == SyntaxKind.QuestionOpenBracketToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.IndexExpression

    /// Gets the expression being indexed.
    prop Target ExpressionSyntax {
        get;
    }

    /// Gets the opening bracket token (either `[` or `?[`).
    prop OpenBracketToken SyntaxToken {
        get;
    }

    /// Gets the index expression.
    @SyntaxChildIgnore
    prop Index ExpressionSyntax -> Indices[0]

    /// Gets index expressions.
    prop Indices SeparatedSyntaxList[ExpressionSyntax] {
        get;
    }

    /// Gets the closing bracket token.
    prop CloseBracketToken SyntaxToken {
        get;
    }

    /// Gets a value indicating whether this index expression uses the
    /// null-conditional form (`?[`) introduced by ADR-0073 / issue #710.
    prop IsNullConditional bool {
        get;
    }
}
