// <copyright file="ConditionalRefArgumentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// ADR-0061: a call-site-only conditional lvalue expression of the form
/// `<cond> ? <lvalue> : <lvalue>`. Recognised by the parser only as
/// the payload of a ref-kind modifier (`ref`/`out`/`in`) or as the
/// operand of the `&` address-of operator. The two branches may each
/// optionally carry an inner ref-kind modifier (`WhenTrueRefKindModifier` /
/// `WhenFalseRefKindModifier`) for parity with the C# spelling
/// `f(cond ? ref x : ref y)`; when present, they must match the outer
/// modifier (validated at bind time).
partial class ConditionalRefArgumentExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:ConditionalRefArgumentExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param condition The condition expression (must be `bool`).
    /// @param questionToken The literal `?` token.
    /// @param whenTrueRefKindModifier Optional inner `ref`/`out`/`in` on the true branch (may be `null`).
    /// @param whenTrue The lvalue expression for the true branch.
    /// @param colonToken The literal `:` token.
    /// @param whenFalseRefKindModifier Optional inner `ref`/`out`/`in` on the false branch (may be `null`).
    /// @param whenFalse The lvalue expression for the false branch.
    init(
        syntaxTree SyntaxTree,
        condition ExpressionSyntax,
        questionToken SyntaxToken,
        whenTrueRefKindModifier SyntaxToken?,
        whenTrue ExpressionSyntax,
        colonToken SyntaxToken,
        whenFalseRefKindModifier SyntaxToken?,
        whenFalse ExpressionSyntax
    ) : base(syntaxTree) {
        Condition = condition
        QuestionToken = questionToken
        WhenTrueRefKindModifier = whenTrueRefKindModifier
        WhenTrue = whenTrue
        ColonToken = colonToken
        WhenFalseRefKindModifier = whenFalseRefKindModifier
        WhenFalse = whenFalse
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ConditionalRefArgumentExpression

    /// Gets the condition expression.
    prop Condition ExpressionSyntax {
        get;
    }

    /// Gets the literal `?` token.
    prop QuestionToken SyntaxToken {
        get;
    }

    /// Gets the optional inner ref-kind modifier on the true branch (`null` when absent).
    prop WhenTrueRefKindModifier SyntaxToken? {
        get;
    }

    /// Gets the lvalue expression for the true branch.
    prop WhenTrue ExpressionSyntax {
        get;
    }

    /// Gets the literal `:` token.
    prop ColonToken SyntaxToken {
        get;
    }

    /// Gets the optional inner ref-kind modifier on the false branch (`null` when absent).
    prop WhenFalseRefKindModifier SyntaxToken? {
        get;
    }

    /// Gets the lvalue expression for the false branch.
    prop WhenFalse ExpressionSyntax {
        get;
    }
}
