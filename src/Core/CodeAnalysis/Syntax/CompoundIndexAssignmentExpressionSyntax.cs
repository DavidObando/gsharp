#nullable disable

// <copyright file="CompoundIndexAssignmentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a compound indexer assignment of the form
/// <c>target[index] op= value</c> (e.g. <c>d[k] += 1</c>, <c>obj.Map[k] -= 2</c>).
/// Issue #507 follow-up: this complements
/// <see cref="IndexAssignmentExpressionSyntax"/> and
/// <see cref="MemberIndexAssignmentExpressionSyntax"/>, which only handle the
/// plain <c>=</c> case. The binder evaluates the indexed receiver exactly once
/// (via a synthesized temp local) and lowers the node to the equivalent
/// <c>target[index] = target[index] op value</c>.
/// </summary>
public sealed class CompoundIndexAssignmentExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the
    /// <see cref="CompoundIndexAssignmentExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="target">The parsed indexer access on the left of the operator.</param>
    /// <param name="operatorToken">The compound assignment token (e.g. <c>+=</c>).</param>
    /// <param name="value">The value expression on the right of the operator.</param>
    public CompoundIndexAssignmentExpressionSyntax(
        SyntaxTree syntaxTree,
        IndexExpressionSyntax target,
        SyntaxToken operatorToken,
        ExpressionSyntax value)
        : base(syntaxTree)
    {
        Target = target;
        OperatorToken = operatorToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.CompoundIndexAssignmentExpression;

    /// <summary>Gets the indexer access expression on the left of the operator.</summary>
    public IndexExpressionSyntax Target { get; }

    /// <summary>Gets the compound assignment operator token.</summary>
    public SyntaxToken OperatorToken { get; }

    /// <summary>Gets the value expression on the right of the operator.</summary>
    public ExpressionSyntax Value { get; }
}
