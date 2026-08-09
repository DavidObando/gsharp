// <copyright file="FieldAssignmentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a field assignment <c>variable.Field = value</c> (Phase 3.B.1).
/// </summary>
public sealed class FieldAssignmentExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="FieldAssignmentExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="receiver">The receiver identifier.</param>
    /// <param name="dotToken">The dot.</param>
    /// <param name="fieldIdentifier">The field name.</param>
    /// <param name="equalsToken">The <c>=</c> token.</param>
    /// <param name="value">The value expression.</param>
    public FieldAssignmentExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken receiver,
        SyntaxToken dotToken,
        SyntaxToken fieldIdentifier,
        SyntaxToken equalsToken,
        ExpressionSyntax value)
        : base(syntaxTree)
    {
        Receiver = receiver;
        DotToken = dotToken;
        FieldIdentifier = fieldIdentifier;
        EqualsToken = equalsToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.FieldAssignmentExpression;

    /// <summary>Gets the receiver identifier.</summary>
    public SyntaxToken Receiver { get; }

    /// <summary>Gets the dot token.</summary>
    public SyntaxToken DotToken { get; }

    /// <summary>Gets the field identifier.</summary>
    public SyntaxToken FieldIdentifier { get; }

    /// <summary>Gets the equals token.</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the value expression.</summary>
    public ExpressionSyntax Value { get; }
}
