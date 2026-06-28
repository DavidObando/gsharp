#nullable disable

// <copyright file="ContinueStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents the continue statement in the language. An optional trailing
/// identifier (on the same source line) names an enclosing labeled loop
/// (ADR-0070).
/// </summary>
public class ContinueStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ContinueStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="keyword">The continue keyword.</param>
    /// <param name="labelIdentifier">
    /// Optional target label identifier (must appear on the same source line
    /// as the <paramref name="keyword"/>); <see langword="null"/> for an
    /// innermost-loop continue.
    /// </param>
    public ContinueStatementSyntax(SyntaxTree syntaxTree, SyntaxToken keyword, SyntaxToken labelIdentifier = null)
        : base(syntaxTree)
    {
        Keyword = keyword;
        LabelIdentifier = labelIdentifier;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ContinueStatement;

    /// <summary>
    /// Gets the continue keyword.
    /// </summary>
    public SyntaxToken Keyword { get; }

    /// <summary>
    /// Gets the optional target label identifier (<see langword="null"/> when
    /// the continue targets the innermost enclosing loop).
    /// </summary>
    public SyntaxToken LabelIdentifier { get; }
}
