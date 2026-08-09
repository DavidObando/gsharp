// <copyright file="WithExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents <c>expr with { Field = value, ... }</c> data-struct copy sugar.
/// </summary>
public sealed class WithExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="WithExpressionSyntax"/> class.</summary>
    /// <param name="receiver">The copied expression.</param>
    /// <param name="withToken">The contextual <c>with</c> token.</param>
    /// <param name="openBraceToken">The opening brace.</param>
    /// <param name="initializers">The field overrides.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public WithExpressionSyntax(ExpressionSyntax receiver, SyntaxToken withToken, SyntaxToken openBraceToken, SeparatedSyntaxList<FieldInitializerSyntax> initializers, SyntaxToken closeBraceToken)
        : base(receiver.SyntaxTree)
    {
        Receiver = receiver;
        WithToken = withToken;
        OpenBraceToken = openBraceToken;
        Initializers = initializers;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.WithExpression;

    /// <summary>Gets the copied expression.</summary>
    public ExpressionSyntax Receiver { get; }

    /// <summary>Gets the contextual <c>with</c> token.</summary>
    public SyntaxToken WithToken { get; }

    /// <summary>Gets the opening brace.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the field overrides.</summary>
    public SeparatedSyntaxList<FieldInitializerSyntax> Initializers { get; }

    /// <summary>Gets the closing brace.</summary>
    public SyntaxToken CloseBraceToken { get; }
}
