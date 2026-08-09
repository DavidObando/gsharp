// <copyright file="GotoStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>goto label</c> statement (issue #1884): an unconditional
/// jump to a statement elsewhere in the enclosing function marked with
/// <c>label:</c> (<see cref="LabeledStatementSyntax"/>).
/// </summary>
public sealed class GotoStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="GotoStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="keyword">The <c>goto</c> keyword.</param>
    /// <param name="labelIdentifier">The target label identifier.</param>
    public GotoStatementSyntax(SyntaxTree syntaxTree, SyntaxToken keyword, SyntaxToken labelIdentifier)
        : base(syntaxTree)
    {
        Keyword = keyword;
        LabelIdentifier = labelIdentifier;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.GotoStatement;

    /// <summary>
    /// Gets the <c>goto</c> keyword.
    /// </summary>
    public SyntaxToken Keyword { get; }

    /// <summary>
    /// Gets the target label identifier.
    /// </summary>
    public SyntaxToken LabelIdentifier { get; }
}
