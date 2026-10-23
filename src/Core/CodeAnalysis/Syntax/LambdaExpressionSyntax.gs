// <copyright file="LambdaExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// ADR-0074 / issue #714: a lambda-expression of the form
/// `[async] (p1 T1, p2 T2) -> body`. The parameter list is always
/// parenthesised; the body may be either a single expression or a
/// brace-delimited (cref:BlockExpressionSyntax). Bound to a
/// bound function-literal node, reusing every downstream consumer
/// (closure capture, emit, interpreter, etc.) that already handles
/// function literals.
/// @remarks ADR-0076 / issue #716 extended this node in two ways:
/// - <b>Optional async modifier.</b> A leading `async` keyword marks an async arrow lambda; the binder
/// lowers `async (T) -> R` to a function type `(T) -> Task[R]`, matching the long-standing
/// `async func(T) R` behaviour.
/// - <b>Optional parameter type clauses.</b> A lambda parameter may omit its type clause when the
/// binding supplies a target function type from which the parameter type can be inferred (e.g.
/// `let f (int32) -> int32 = (x) -> x + 1`). When no target type is available, the binder reports
/// GS0304.
partial class LambdaExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:LambdaExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param asyncModifier Optional `async` modifier preceding the parameter list (ADR-0076 / issue #716).
    /// `null` when the lambda is synchronous.
    /// @param openParenToken The opening `(` token of the parameter list.
    /// @param parameters The (possibly empty) parenthesised parameter list.
    /// @param closeParenToken The closing `)` token of the parameter list.
    /// @param arrowToken The `->` token separating the parameter list from the body.
    /// @param body The lambda body — a single expression, or a brace-delimited block expression.
    init(
        syntaxTree SyntaxTree,
        asyncModifier SyntaxToken?,
        openParenToken SyntaxToken?,
        parameters SeparatedSyntaxList[ParameterSyntax],
        closeParenToken SyntaxToken?,
        arrowToken SyntaxToken,
        body ExpressionSyntax
    ) : base(syntaxTree) {
        AsyncModifier = asyncModifier
        OpenParenToken = openParenToken
        Parameters = parameters
        CloseParenToken = closeParenToken
        ArrowToken = arrowToken
        Body = body
    }

    /// Initializes a new instance of the (cref:LambdaExpressionSyntax) class
    /// without an async modifier (ADR-0074 / issue #714 original shape).
    /// @param syntaxTree The parent syntax tree.
    /// @param openParenToken The opening `(` token of the parameter list.
    /// @param parameters The (possibly empty) parenthesised parameter list.
    /// @param closeParenToken The closing `)` token of the parameter list.
    /// @param arrowToken The `->` token separating the parameter list from the body.
    /// @param body The lambda body — a single expression, or a brace-delimited block expression.
    convenience init(
        syntaxTree SyntaxTree,
        openParenToken SyntaxToken?,
        parameters SeparatedSyntaxList[ParameterSyntax],
        closeParenToken SyntaxToken?,
        arrowToken SyntaxToken,
        body ExpressionSyntax
    ) {
        init(syntaxTree, nil, openParenToken, parameters, closeParenToken, arrowToken, body)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.LambdaExpression

    /// Gets the optional `async` modifier preceding the parameter list (ADR-0076 / issue #716). `null` when
    /// the lambda is synchronous.
    prop AsyncModifier SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether the lambda carries an `async` modifier.
    prop IsAsync bool -> AsyncModifier != nil

    /// Gets the opening `(` token of the parameter list.
    prop OpenParenToken SyntaxToken? {
        get;
    }

    /// Gets the parenthesised parameter list (possibly empty).
    prop Parameters SeparatedSyntaxList[ParameterSyntax] {
        get;
    }

    /// Gets the closing `)` token of the parameter list.
    prop CloseParenToken SyntaxToken? {
        get;
    }

    /// Gets the `->` arrow token.
    prop ArrowToken SyntaxToken {
        get;
    }

    /// Gets the lambda body — either a single expression, or a brace-delimited block expression.
    prop Body ExpressionSyntax {
        get;
    }
}
