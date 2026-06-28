#nullable disable

// <copyright file="MemberIndexAssignmentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an indexer assignment whose target is an arbitrary expression
/// rather than a bare identifier, e.g. <c>obj.Member[key] = value</c> or
/// <c>GetThing()[i] = v</c>. Issue #507: this complements
/// <see cref="IndexAssignmentExpressionSyntax"/> (which is restricted to a
/// single identifier on the left of the brackets) by allowing the indexed
/// target to be any expression that produces an indexable value.
/// </summary>
public sealed class MemberIndexAssignmentExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="MemberIndexAssignmentExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="target">The parsed indexer access on the left of the equals sign.</param>
    /// <param name="equalsToken">The equals token.</param>
    /// <param name="value">The value expression on the right of the equals sign.</param>
    public MemberIndexAssignmentExpressionSyntax(
        SyntaxTree syntaxTree,
        IndexExpressionSyntax target,
        SyntaxToken equalsToken,
        ExpressionSyntax value)
        : base(syntaxTree)
    {
        Target = target;
        EqualsToken = equalsToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.MemberIndexAssignmentExpression;

    /// <summary>Gets the indexer access expression on the left of the equals sign.</summary>
    public IndexExpressionSyntax Target { get; }

    /// <summary>Gets the equals token.</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the value expression on the right of the equals sign.</summary>
    public ExpressionSyntax Value { get; }
}
