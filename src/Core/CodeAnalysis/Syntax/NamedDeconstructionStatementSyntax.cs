// <copyright file="NamedDeconstructionStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents <c>let { Field = local, ... } = expr</c> data-struct deconstruction.
/// </summary>
public sealed class NamedDeconstructionStatementSyntax : StatementSyntax
{
    /// <summary>Initializes a new instance of the <see cref="NamedDeconstructionStatementSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="keyword">The <c>let</c> keyword.</param>
    /// <param name="openBraceToken">The opening brace.</param>
    /// <param name="fields">The named field bindings.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    /// <param name="equalsToken">The equals token before the initializer.</param>
    /// <param name="initializer">The initializer expression.</param>
    public NamedDeconstructionStatementSyntax(SyntaxTree syntaxTree, SyntaxToken keyword, SyntaxToken openBraceToken, SeparatedSyntaxList<NamedDeconstructionFieldSyntax> fields, SyntaxToken closeBraceToken, SyntaxToken equalsToken, ExpressionSyntax initializer)
        : base(syntaxTree)
    {
        Keyword = keyword;
        OpenBraceToken = openBraceToken;
        Fields = fields;
        CloseBraceToken = closeBraceToken;
        EqualsToken = equalsToken;
        Initializer = initializer;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.NamedDeconstructionStatement;

    /// <summary>Gets the <c>let</c> keyword.</summary>
    public SyntaxToken Keyword { get; }

    /// <summary>Gets the opening brace.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the named field bindings.</summary>
    public SeparatedSyntaxList<NamedDeconstructionFieldSyntax> Fields { get; }

    /// <summary>Gets the closing brace.</summary>
    public SyntaxToken CloseBraceToken { get; }

    /// <summary>Gets the equals token before the initializer.</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the initializer expression.</summary>
    public ExpressionSyntax Initializer { get; }
}
