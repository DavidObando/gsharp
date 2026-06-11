// <copyright file="NullCoalescingAssignmentStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0072 / issue #709: a null-coalescing compound assignment statement of
/// the form <c>target ??= value</c>. Semantically equivalent to
/// <c>if target == nil { target = value }</c>; the right-hand side is
/// evaluated only when the target reads as nil. Statement-level only in G#
/// — there is no expression form. The target must be a nullable lvalue
/// (local, parameter, field, property, or indexer); the binder reports
/// <c>GS0298</c> when the target type is not nullable.
/// </summary>
public sealed class NullCoalescingAssignmentStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the
    /// <see cref="NullCoalescingAssignmentStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="target">The target lvalue (left-hand side).</param>
    /// <param name="operatorToken">The <c>??=</c> operator token.</param>
    /// <param name="value">The right-hand-side value expression.</param>
    public NullCoalescingAssignmentStatementSyntax(
        SyntaxTree syntaxTree,
        ExpressionSyntax target,
        SyntaxToken operatorToken,
        ExpressionSyntax value)
        : base(syntaxTree)
    {
        Target = target;
        OperatorToken = operatorToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.NullCoalescingAssignmentStatement;

    /// <summary>
    /// Gets the target lvalue expression.
    /// </summary>
    public ExpressionSyntax Target { get; }

    /// <summary>
    /// Gets the <c>??=</c> operator token.
    /// </summary>
    public SyntaxToken OperatorToken { get; }

    /// <summary>
    /// Gets the right-hand-side value expression.
    /// </summary>
    public ExpressionSyntax Value { get; }
}
