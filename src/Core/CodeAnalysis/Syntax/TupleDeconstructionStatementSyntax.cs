#nullable disable

// <copyright file="TupleDeconstructionStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// A tuple deconstruction declaration <c>let (a, b, ...) = expr</c> (Phase 4.5).
/// Each identifier becomes an immutable local bound to the corresponding tuple
/// element of the right-hand-side initializer.
/// </summary>
public sealed class TupleDeconstructionStatementSyntax : StatementSyntax
{
    /// <summary>Initializes a new instance of the <see cref="TupleDeconstructionStatementSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="keyword">The <c>let</c> keyword.</param>
    /// <param name="openParenToken">The opening <c>(</c>.</param>
    /// <param name="identifiers">The comma-separated identifier list.</param>
    /// <param name="closeParenToken">The closing <c>)</c>.</param>
    /// <param name="equalsToken">The <c>=</c> token.</param>
    /// <param name="initializer">The tuple-typed initializer expression.</param>
    public TupleDeconstructionStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken keyword,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<SyntaxToken> identifiers,
        SyntaxToken closeParenToken,
        SyntaxToken equalsToken,
        ExpressionSyntax initializer)
        : base(syntaxTree)
    {
        Keyword = keyword;
        OpenParenToken = openParenToken;
        Identifiers = identifiers;
        CloseParenToken = closeParenToken;
        EqualsToken = equalsToken;
        Initializer = initializer;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.TupleDeconstructionStatement;

    /// <summary>Gets the <c>let</c> keyword token.</summary>
    public SyntaxToken Keyword { get; }

    /// <summary>Gets the opening parenthesis token.</summary>
    public SyntaxToken OpenParenToken { get; }

    /// <summary>Gets the deconstruction target identifiers.</summary>
    public SeparatedSyntaxList<SyntaxToken> Identifiers { get; }

    /// <summary>Gets the closing parenthesis token.</summary>
    public SyntaxToken CloseParenToken { get; }

    /// <summary>Gets the equals token.</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the right-hand-side tuple expression.</summary>
    public ExpressionSyntax Initializer { get; }
}
