// <copyright file="IndirectCompoundAssignmentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1925: syntax for a compound indirect assignment <c>*p op= expr</c>
/// (e.g. <c>*(p + i) += 1</c>, <c>*p -= 2</c>). Complements
/// <see cref="IndirectAssignmentExpressionSyntax"/>, which only handles the
/// plain <c>=</c> case. The <see cref="Target"/> is a
/// <see cref="UnaryExpressionSyntax"/> whose operator is <c>*</c>
/// (unmanaged/managed pointer dereference). The binder evaluates the pointer
/// expression exactly once (via a synthesized temp local) and lowers the node
/// to the equivalent <c>*tmp = *tmp op value</c>.
/// </summary>
public sealed class IndirectCompoundAssignmentExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="IndirectCompoundAssignmentExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="target">The <c>*p</c> dereference target (unary expression with <c>*</c> operator).</param>
    /// <param name="operatorToken">The compound assignment token (e.g. <c>+=</c>).</param>
    /// <param name="value">The right-hand-side expression on the right of the operator.</param>
    public IndirectCompoundAssignmentExpressionSyntax(SyntaxTree syntaxTree, UnaryExpressionSyntax target, SyntaxToken operatorToken, ExpressionSyntax value)
        : base(syntaxTree)
    {
        Target = target;
        OperatorToken = operatorToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.IndirectCompoundAssignmentExpression;

    /// <summary>Gets the <c>*p</c> dereference target.</summary>
    public UnaryExpressionSyntax Target { get; }

    /// <summary>Gets the compound assignment operator token.</summary>
    public SyntaxToken OperatorToken { get; }

    /// <summary>Gets the right-hand-side value on the right of the operator.</summary>
    public ExpressionSyntax Value { get; }
}
