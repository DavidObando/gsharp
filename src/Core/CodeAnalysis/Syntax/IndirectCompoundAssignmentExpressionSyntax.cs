// <copyright file="IndirectCompoundAssignmentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1925 / #4350: syntax for a compound assignment through addressable
/// storage, including <c>*p op= expr</c> and <c>GetRef() op= expr</c>.
/// Complements <see cref="IndirectAssignmentExpressionSyntax"/>, which handles
/// the plain <c>=</c> case. The binder evaluates the target address exactly
/// once (via a synthesized temp local) and lowers the node to the equivalent
/// <c>*tmp = *tmp op value</c>.
/// </summary>
public sealed class IndirectCompoundAssignmentExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="IndirectCompoundAssignmentExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="target">The pointer dereference or writable ref-returning call.</param>
    /// <param name="operatorToken">The compound assignment token (e.g. <c>+=</c>).</param>
    /// <param name="value">The right-hand-side expression on the right of the operator.</param>
    public IndirectCompoundAssignmentExpressionSyntax(SyntaxTree syntaxTree, ExpressionSyntax target, SyntaxToken operatorToken, ExpressionSyntax value)
        : base(syntaxTree)
    {
        Target = target;
        OperatorToken = operatorToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.IndirectCompoundAssignmentExpression;

    /// <summary>Gets the addressable compound-assignment target.</summary>
    public ExpressionSyntax Target { get; }

    /// <summary>Gets the compound assignment operator token.</summary>
    public SyntaxToken OperatorToken { get; }

    /// <summary>Gets the right-hand-side value on the right of the operator.</summary>
    public ExpressionSyntax Value { get; }
}
