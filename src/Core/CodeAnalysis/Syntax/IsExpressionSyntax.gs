// <copyright file="IsExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents an expression-level pattern test: `expr is pattern` → `bool`.
/// Issues #575 and #3351.
class IsExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:IsExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param expression The expression whose runtime type is tested.
    /// @param isKeyword The `is` keyword token.
    /// @param pattern The pattern tested against the expression value.
    init(syntaxTree SyntaxTree, expression ExpressionSyntax, isKeyword SyntaxToken, pattern PatternSyntax) : base(
        syntaxTree
    ) {
        Expression = expression
        IsKeyword = isKeyword
        Pattern = pattern
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.IsExpression

    /// Gets the left-hand expression being type-tested.
    prop Expression ExpressionSyntax {
        get;
    }

    /// Gets the `is` keyword token.
    prop IsKeyword SyntaxToken {
        get;
    }

    /// Gets the pattern tested against the expression value.
    prop Pattern PatternSyntax {
        get;
    }

    /// Gets the target type clause for a direct type test, or `null`
    /// for a general pattern.
    @SyntaxChildIgnore
    prop TypeClause TypeClauseSyntax? -> switch Pattern {
        case typePattern is TypePatternSyntax: typePattern.Type
        case candidate is TypeOrConstantPatternSyntax: candidate.CandidateType
        default: default(TypeClauseSyntax?)
    }
}
