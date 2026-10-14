// <copyright file="ConditionalExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// ADR-0062: a general two-arm conditional (ternary) expression of the form
/// `<cond> ? <ifTrue> : <ifFalse>`. Valid in any expression
/// position. The operator is right-associative and binds at a lower precedence
/// than logical-or but higher than assignment.
/// @remarks In ref-kind argument payloads (`ref`/`out`/`in`) and as the
/// operand of `&`, this same syntax is reinterpreted by the binder as
/// a conditional address-of
/// ((cref:GSharp.Core.CodeAnalysis.Binding.BoundConditionalAddressExpression)),
/// preserving ADR-0061's byref semantics.
class ConditionalExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:ConditionalExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param condition The condition expression.
    /// @param questionToken The literal `?` token.
    /// @param whenTrue The expression evaluated when the condition is `true`.
    /// @param colonToken The literal `:` token.
    /// @param whenFalse The expression evaluated when the condition is `false`.
    init(
        syntaxTree SyntaxTree,
        condition ExpressionSyntax,
        questionToken SyntaxToken,
        whenTrue ExpressionSyntax,
        colonToken SyntaxToken,
        whenFalse ExpressionSyntax
    ) : base(syntaxTree) {
        Condition = condition
        QuestionToken = questionToken
        WhenTrue = whenTrue
        ColonToken = colonToken
        WhenFalse = whenFalse
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ConditionalExpression

    /// Gets the condition expression.
    prop Condition ExpressionSyntax {
        get;
    }

    /// Gets the literal `?` token.
    prop QuestionToken SyntaxToken {
        get;
    }

    /// Gets the expression evaluated when the condition is `true`.
    prop WhenTrue ExpressionSyntax {
        get;
    }

    /// Gets the literal `:` token.
    prop ColonToken SyntaxToken {
        get;
    }

    /// Gets the expression evaluated when the condition is `false`.
    prop WhenFalse ExpressionSyntax {
        get;
    }
}
